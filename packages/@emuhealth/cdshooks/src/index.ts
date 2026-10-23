import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import {
  getFhirStore,
  issueSmartToken,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedSyntheticRecords,
  seedTerminology,
  type FhirResource,
  type FhirSeedConfig,
} from "@emuhealth/fhir-core";

/**
 * CDS Hooks emulator. It plays the EHR: it reads a CDS service's discovery document, fires patient-view and
 * order-sign hooks with a signed JWT, context, prefetch from its own synthetic FHIR server, and a FHIR access
 * token, and checks the cards that come back. It also serves sample CDS services, so EHR-side code has something
 * to call.
 */
export interface CdsHooksSeedConfig extends FhirSeedConfig {
  /** Discovery URLs of CDS services to list in the inspector, for example http://localhost:3000/cds-services. */
  services?: string[];
}

const DATA_KEY = "cdshooks.data";
const SERVICE_LABEL = "CDS Hooks";
export const SUPPORTED_HOOKS = ["patient-view", "order-sign", "order-select", "encounter-start"] as const;

interface Invocation {
  id: string;
  at: string;
  serviceUrl: string;
  hook: string;
  status: number | null;
  request: unknown;
  response: unknown;
  issues: string[];
}

interface Data {
  services: string[];
  invocations: Invocation[];
  feedback: unknown[];
}

function data(store: Store): Data {
  let d = store.getData<Data>(DATA_KEY);
  if (!d) {
    d = { services: [], invocations: [], feedback: [] };
    store.setData(DATA_KEY, d);
  }
  return d;
}

export function seedFromConfig(store: Store, baseUrl: string, config: CdsHooksSeedConfig): void {
  const { services, ...fhirConfig } = config;
  if (services !== undefined) {
    if (!Array.isArray(services) || services.some((s) => typeof s !== "string" || !/^https?:\/\//.test(s)))
      throw new Error("cdshooks.services must be an array of http(s) discovery URLs");
    data(store).services = services;
  }
  seedFhirFromConfig(store, baseUrl, fhirConfig);
}

type Card = Record<string, unknown>;

/** Problems with a CDS Hooks response, per the CDS Hooks 2.0 card rules. */
export function validateCards(body: unknown): string[] {
  const issues: string[] = [];
  if (!body || typeof body !== "object" || !Array.isArray((body as { cards?: unknown }).cards))
    return ["The response must be a JSON object with a cards array"];
  for (const [i, card] of ((body as { cards: Card[] }).cards ?? []).entries()) {
    const at = `cards[${i}]`;
    if (typeof card.summary !== "string" || !card.summary) issues.push(`${at}.summary is required`);
    else if (card.summary.length > 140) issues.push(`${at}.summary must be 140 characters or fewer`);
    if (!["info", "warning", "critical"].includes(String(card.indicator)))
      issues.push(`${at}.indicator must be info, warning, or critical`);
    const source = card.source as { label?: unknown } | undefined;
    if (!source || typeof source.label !== "string" || !source.label) issues.push(`${at}.source.label is required`);
    for (const [j, link] of ((card.links as Array<Record<string, unknown>> | undefined) ?? []).entries()) {
      if (!link.label || !link.url) issues.push(`${at}.links[${j}] needs label and url`);
      if (!["absolute", "smart"].includes(String(link.type)))
        issues.push(`${at}.links[${j}].type must be absolute or smart`);
    }
    for (const [j, suggestion] of ((card.suggestions as Array<Record<string, unknown>> | undefined) ?? []).entries()) {
      if (typeof suggestion.label !== "string") issues.push(`${at}.suggestions[${j}].label is required`);
      for (const [k, action] of ((suggestion.actions as Array<Record<string, unknown>> | undefined) ?? []).entries())
        if (!["create", "update", "delete"].includes(String(action.type)))
          issues.push(`${at}.suggestions[${j}].actions[${k}].type must be create, update, or delete`);
    }
    if (card.selectionBehavior !== undefined && !["at-most-one", "any"].includes(String(card.selectionBehavior)))
      issues.push(`${at}.selectionBehavior must be at-most-one or any`);
  }
  return issues;
}

/** Replace {{context.x}} and {{userPractitionerId}} tokens in a prefetch template. */
function fillTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key.startsWith("context.")) return String(context[key.slice("context.".length)] ?? "");
    if (key === "userPractitionerId") return String(context.userId ?? "").replace(/^Practitioner\//, "");
    if (key === "userPractitionerRoleId") return "";
    return "";
  });
}

type AnyContext = Context<AppEnv>;

export const cdshooksPlugin: ServicePlugin = {
  name: "cdshooks",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/+$/, "");
    const fhirBase = `${origin}/fhir`;
    const keys = generateKeyPair("RS384", { extractable: true });
    const kid = "emuhealth-cds-ehr-1";

    // The EHR's own synthetic FHIR server, for fhirServer and prefetch.
    registerFhirRoutes(app, store, {
      baseUrl: origin,
      basePath: "/fhir",
      software: { name: "emuhealth CDS Hooks EHR" },
      inspectorPath: false,
    });

    app.get("/.well-known/jwks.json", async (c) => {
      const jwk = await exportJWK((await keys).publicKey);
      return c.json({ keys: [{ ...jwk, kid, alg: "RS384", use: "sig" }] });
    });

    /** Fire a hook at one service from a discovery document, the way an EHR does. */
    async function fire(
      discoveryUrl: string,
      serviceId: string | undefined,
      hook: string,
      context: Record<string, unknown>,
    ) {
      const issues: string[] = [];
      const discoveryRes = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
      const discovery = (await discoveryRes.json()) as { services?: Array<Record<string, unknown>> };
      const services = discovery.services ?? [];
      if (!Array.isArray(discovery.services)) issues.push("The discovery response must have a services array");
      const service = services.find((s) => (serviceId ? s.id === serviceId : s.hook === hook));
      if (!service)
        throw new Error(serviceId ? `No service ${serviceId} in the discovery response` : `No service for ${hook}`);
      for (const field of ["hook", "description", "id"])
        if (typeof service[field] !== "string")
          issues.push(`Discovery: services[${services.indexOf(service)}].${field} is required`);
      const serviceUrl = `${discoveryUrl.replace(/\/+$/, "")}/${encodeURIComponent(String(service.id))}`;

      // Prefetch from the EHR's own FHIR server.
      const prefetch: Record<string, unknown> = {};
      for (const [key, template] of Object.entries((service.prefetch as Record<string, string> | undefined) ?? {})) {
        const query = fillTemplate(template, context);
        const res = await app.request(`${fhirBase}/${query}`);
        prefetch[key] = res.ok ? await res.json() : null;
      }

      // A token the service can use to read more from the FHIR server, scoped to the patient.
      const accessToken = randomUUID();
      issueSmartToken(store, {
        token: accessToken,
        clientId: "cds-service",
        scope: "patient/*.read",
        patient: String(context.patientId ?? ""),
        expiresAt: Date.now() + 300_000,
      });
      const body = {
        hookInstance: randomUUID(),
        hook,
        fhirServer: fhirBase,
        fhirAuthorization: {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          scope: "patient/*.read",
          subject: "cds-service",
          patient: context.patientId,
        },
        context,
        ...(Object.keys(prefetch).length ? { prefetch } : {}),
      };
      const jwt = await new SignJWT({ jti: randomUUID() })
        .setProtectedHeader({ alg: "RS384", kid, typ: "JWT", jku: `${origin}/.well-known/jwks.json` })
        .setIssuer(origin)
        .setAudience(serviceUrl)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign((await keys).privateKey);
      let status: number | null = null;
      let response: unknown = null;
      try {
        const res = await fetch(serviceUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify(body),
        });
        status = res.status;
        const text = await res.text();
        try {
          response = JSON.parse(text);
        } catch {
          response = text;
          issues.push("The response is not JSON");
        }
        if (!res.ok) issues.push(`The service returned HTTP ${res.status}`);
        else issues.push(...validateCards(response));
      } catch (err) {
        issues.push(`Could not reach ${serviceUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const invocation: Invocation = {
        id: randomUUID(),
        at: new Date().toISOString(),
        serviceUrl,
        hook,
        status,
        request: body,
        response,
        issues,
      };
      data(store).invocations.unshift(invocation);
      data(store).invocations.splice(100);
      return invocation;
    }

    /** The context for a hook, filled with the patient's synthetic records. */
    function contextFor(hook: string, patientId: string, medicationText?: string): Record<string, unknown> {
      const fhir = getFhirStore(store);
      const practitioner = fhir.listCurrent("Practitioner")[0];
      const encounter = fhir
        .listCurrent("Encounter")
        .find((e) => (e.subject as { reference?: string } | undefined)?.reference === `Patient/${patientId}`);
      const context: Record<string, unknown> = {
        userId: practitioner ? `Practitioner/${practitioner.id}` : "Practitioner/unknown",
        patientId,
        ...(encounter ? { encounterId: encounter.id } : {}),
      };
      if (hook === "order-sign" || hook === "order-select") {
        const draft: FhirResource = {
          resourceType: "MedicationRequest",
          id: `draft-${randomUUID().slice(0, 8)}`,
          status: "draft",
          intent: "order",
          medicationCodeableConcept: { text: medicationText || "amoxicillin 500 MG Oral Capsule" },
          subject: { reference: `Patient/${patientId}` },
        };
        context.draftOrders = { resourceType: "Bundle", type: "collection", entry: [{ resource: draft }] };
        if (hook === "order-select") context.selections = [`MedicationRequest/${draft.id}`];
      }
      return context;
    }

    // Fire a hook from code: POST /ehr/fire { discoveryUrl, hook, patientId, serviceId?, context? }.
    app.post("/ehr/fire", async (c) => {
      let input: Record<string, unknown>;
      try {
        input = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json({ error: "The body must be JSON" }, 400);
      }
      const hook = String(input.hook ?? "patient-view");
      const discoveryUrl = String(input.discoveryUrl ?? "");
      if (!/^https?:\/\//.test(discoveryUrl)) return c.json({ error: "discoveryUrl must be an http(s) URL" }, 400);
      const patientId = String(input.patientId ?? "syn-patient-001");
      const context = {
        ...contextFor(hook, patientId, input.medication as string | undefined),
        ...((input.context as object) ?? {}),
      };
      try {
        const invocation = await fire(discoveryUrl, input.serviceId as string | undefined, hook, context);
        return c.json(invocation);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    });
    app.get("/ehr/invocations", (c) => c.json({ invocations: data(store).invocations }));

    // Sample CDS services, so EHR-side code has a service to call.
    const sampleServices = [
      {
        hook: "patient-view",
        id: "patient-greeting",
        title: "Patient greeting",
        description: "Greets the clinician with the patient's name and active problem count.",
        prefetch: { patient: "Patient/{{context.patientId}}", conditions: "Condition?patient={{context.patientId}}" },
      },
      {
        hook: "order-sign",
        id: "allergy-check",
        title: "Allergy check",
        description: "Warns when a draft medication order matches one of the patient's allergies.",
        prefetch: { allergies: "AllergyIntolerance?patient={{context.patientId}}" },
      },
    ];
    app.get("/cds-services", (c) => c.json({ services: sampleServices }));
    app.post("/cds-services/:id", async (c) => {
      let request: Record<string, unknown>;
      try {
        request = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json({ error: "The body must be JSON" }, 400);
      }
      const context = (request.context ?? {}) as Record<string, unknown>;
      const prefetch = (request.prefetch ?? {}) as Record<string, FhirResource | null>;
      const fhir = getFhirStore(store);
      const source = { label: "emuhealth sample CDS service", url: `${origin}/cds-services` };
      if (c.req.param("id") === "patient-greeting") {
        const patient =
          (prefetch.patient as FhirResource | undefined) ?? fhir.find("Patient", String(context.patientId ?? ""));
        if (!patient) return c.json({ cards: [] });
        const name = (patient.name as Array<{ given?: string[]; family?: string }> | undefined)?.[0];
        const problems =
          ((prefetch.conditions as { total?: number } | null | undefined)?.total as number | undefined) ??
          fhir
            .listCurrent("Condition")
            .filter((r) => (r.subject as { reference?: string } | undefined)?.reference === `Patient/${patient.id}`)
            .length;
        return c.json({
          cards: [
            {
              uuid: randomUUID(),
              summary:
                `Synthetic patient ${name?.given?.[0] ?? ""} ${name?.family ?? ""} has ${problems} active problem${problems === 1 ? "" : "s"}`.replace(
                  /\s+/g,
                  " ",
                ),
              indicator: "info",
              source,
            },
          ],
        });
      }
      if (c.req.param("id") === "allergy-check") {
        const drafts = (
          (context.draftOrders as { entry?: Array<{ resource: FhirResource }> } | undefined)?.entry ?? []
        ).map((e) => e.resource);
        const allergies = (
          (prefetch.allergies as { entry?: Array<{ resource: FhirResource }> } | null | undefined)?.entry ?? []
        ).map((e) => e.resource);
        const text = (concept: unknown) =>
          String(
            (concept as { text?: string; coding?: Array<{ display?: string }> } | undefined)?.text ??
              (concept as { coding?: Array<{ display?: string }> } | undefined)?.coding?.[0]?.display ??
              "",
          ).toLowerCase();
        const cards = drafts.flatMap((order) => {
          const ordered = text(order.medicationCodeableConcept);
          const match = allergies.find((a) => {
            const allergen = text(a.code).split(/\s+/)[0];
            return allergen && (ordered.includes(allergen) || (allergen === "penicillin" && /cillin/.test(ordered)));
          });
          if (!match) return [];
          return [
            {
              uuid: randomUUID(),
              summary: `Possible allergy: patient is allergic to ${text(match.code)}`,
              detail: `The draft order for ${ordered} may conflict with a recorded allergy. Synthetic decision support for testing only.`,
              indicator: "warning",
              source,
              selectionBehavior: "at-most-one",
              suggestions: [
                {
                  label: "Remove the draft order",
                  uuid: randomUUID(),
                  actions: [
                    {
                      type: "delete",
                      description: "Remove the draft order",
                      resourceId: [`MedicationRequest/${order.id}`],
                    },
                  ],
                },
              ],
              overrideReasons: [
                {
                  code: "benefit-outweighs-risk",
                  system: "https://emuhealth.dev/cds/override",
                  display: "Benefit outweighs risk",
                },
              ],
            },
          ];
        });
        return c.json({ cards });
      }
      return c.json({ error: `No CDS service ${c.req.param("id")}` }, 404);
    });
    app.post("/cds-services/:id/feedback", async (c) => {
      const body = await c.req.json().catch(() => null);
      data(store).feedback.push({ service: c.req.param("id"), at: new Date().toISOString(), body });
      return c.body(null, 200);
    });

    // Inspector: fire hooks from a form and read the invocation log.
    const inspector = (c: AnyContext, result?: Invocation | { error: string }) => {
      const fhir = getFhirStore(store);
      const tab = c.req.query("tab") === "log" ? "log" : "fire";
      const tabs = [
        { id: "fire", label: "Fire a hook", href: "/_inspector" },
        { id: "log", label: `Invocations (${data(store).invocations.length})`, href: "/_inspector?tab=log" },
      ];
      if (tab === "log") {
        const rows = data(store).invocations.map(
          (i) =>
            `<tr><td>${escapeHtml(i.at)}</td><td>${escapeHtml(i.hook)}</td><td>${escapeHtml(i.serviceUrl)}</td><td>${i.status ?? "error"}</td><td>${i.issues.length ? `<span class="badge badge-denied">${i.issues.length} issues</span>` : '<span class="badge badge-granted">ok</span>'}</td></tr>`,
        );
        const body = `<div class="inspector-section"><h2>Invocations</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>time</th><th>hook</th><th>service</th><th>status</th><th>cards</th></tr></thead><tbody>${
          rows.length
            ? rows.join("")
            : '<tr><td colspan="5"><div class="inspector-empty">No hooks fired yet</div></td></tr>'
        }</tbody></table></div></div>`;
        return c.html(renderInspectorPage("CDS Hooks inspector", tabs, "log", body, SERVICE_LABEL));
      }
      const patients = fhir.listCurrent("Patient");
      const option = (value: string, label: string) =>
        `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`;
      const services = [...data(store).services, `${origin}/cds-services`];
      const form = `<div class="inspector-section"><h2>Fire a hook</h2>
<form method="post" action="/_inspector/fire">
<label class="inspector-field">CDS service discovery URL<input name="discoveryUrl" list="cds-discovery" value="${escapeAttr(services[0])}"/></label>
<datalist id="cds-discovery">${services.map((s) => `<option value="${escapeAttr(s)}">`).join("")}</datalist>
<label class="inspector-field">Hook<select name="hook">${SUPPORTED_HOOKS.map((h) => option(h, h)).join("")}</select></label>
<label class="inspector-field">Patient<select name="patientId">${patients
        .map((p) => {
          const name = (p.name as Array<{ given?: string[]; family?: string }> | undefined)?.[0];
          return option(p.id!, `${name?.given?.[0] ?? ""} ${name?.family ?? ""} (${p.id})`);
        })
        .join("")}</select></label>
<label class="inspector-field">Draft medication order (order-sign and order-select)<input name="medication" value="amoxicillin 500 MG Oral Capsule"/></label>
<button type="submit" class="inspector-action">Fire hook</button>
</form></div>`;
      let output = "";
      if (result && "error" in result)
        output = `<div class="inspector-section"><h2>Error</h2><p class="error-msg">${escapeHtml(result.error)}</p></div>`;
      else if (result) {
        const cards = ((result.response as { cards?: Card[] } | null)?.cards ?? []).map(
          (card) =>
            `<div class="s-card"><div class="s-title">${escapeHtml(String(card.summary ?? ""))} <span class="badge ${card.indicator === "critical" ? "badge-denied" : card.indicator === "warning" ? "badge-requested" : "badge-granted"}">${escapeHtml(String(card.indicator ?? ""))}</span></div>${card.detail ? `<p class="s-subtitle">${escapeHtml(String(card.detail))}</p>` : ""}<p class="info-text">${escapeHtml(String((card.source as { label?: string } | undefined)?.label ?? ""))}</p></div>`,
        );
        const issues = result.issues.length
          ? `<ul>${result.issues.map((i) => `<li class="error-msg">${escapeHtml(i)}</li>`).join("")}</ul>`
          : '<p class="info-text">The response follows the CDS Hooks card rules.</p>';
        output = `<div class="inspector-section"><h2>${escapeHtml(result.hook)} to ${escapeHtml(result.serviceUrl)}: HTTP ${result.status ?? "error"}</h2>${cards.join("") || '<p class="inspector-empty">No cards</p>'}${issues}<details class="inspector-detail"><summary>Request</summary><pre class="inspector-json">${escapeHtml(JSON.stringify(result.request, null, 2))}</pre></details><details class="inspector-detail"><summary>Response</summary><pre class="inspector-json">${escapeHtml(JSON.stringify(result.response, null, 2))}</pre></details></div>`;
      }
      return c.html(renderInspectorPage("CDS Hooks inspector", tabs, "fire", form + output, SERVICE_LABEL));
    };
    app.get("/_inspector", (c) => inspector(c));
    app.post("/_inspector/fire", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const hook = form.get("hook") ?? "patient-view";
      const discoveryUrl = form.get("discoveryUrl") ?? "";
      if (!/^https?:\/\//.test(discoveryUrl)) return inspector(c, { error: "The discovery URL must be http(s)" });
      try {
        return inspector(
          c,
          await fire(
            discoveryUrl,
            undefined,
            hook,
            contextFor(hook, form.get("patientId") ?? "syn-patient-001", form.get("medication") ?? undefined),
          ),
        );
      } catch (err) {
        return inspector(c, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
  },
};

export default cdshooksPlugin;
