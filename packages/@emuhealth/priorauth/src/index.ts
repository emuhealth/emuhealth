import { randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  getFhirStore,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  SYNTHETIC_TAG,
  type FhirResource,
  type FhirSeedConfig,
} from "@emuhealth/fhir-core";
import { HCPCS, ruleFor, type CoverageRule, type Decision } from "./rules.js";
import { questionnaires } from "./questionnaires.js";

export { RULES, ruleFor, HCPCS, type CoverageRule } from "./rules.js";
export { questionnaires } from "./questionnaires.js";

/**
 * A synthetic payer's Da Vinci prior authorization services: a CRD CDS service at /cds-services, and at /fhir the
 * DTR Questionnaire/$questionnaire-package operation and PAS Claim/$submit and Claim/$inquire. Not affiliated with
 * any payer.
 */
export const FHIR_PATH = "/fhir";
const CRD = "http://hl7.org/fhir/us/davinci-crd";
const COVERAGE_INFO = `${CRD}/StructureDefinition/ext-coverage-information`;
/** Stand-in for PAS's X12 review action, which uses licensed X12 code lists that emuhealth does not bundle. */
export const REVIEW_DECISION = "urn:emuhealth:extension:priorauth-review-decision";

export type PriorAuthSeedConfig = FhirSeedConfig;

type AnyContext = Context<AppEnv>;
type Json = Record<string, any>;
const fhirJson = (c: AnyContext, body: unknown, status = 200) =>
  c.body(JSON.stringify(body), status as never, { "Content-Type": FHIR_JSON });

const orderCode = (order: Json): string | undefined =>
  (order.codeCodeableConcept ?? order.code)?.coding?.find((c: Json) => c.system === HCPCS)?.code;

function seedQuestionnaires(store: Store, baseUrl: string): void {
  const fhir = getFhirStore(store);
  for (const q of questionnaires(`${baseUrl.replace(/\/$/, "")}${FHIR_PATH}`)) fhir.update("Questionnaire", q.id!, q);
}

export function seedFromConfig(store: Store, baseUrl: string, config: PriorAuthSeedConfig): void {
  seedFhirFromConfig(store, baseUrl, config);
}

// CRD: the coverage-information extension for one draft order.
function coverageInformation(rule: CoverageRule | undefined, coverage: string, base: string): Json {
  const ext = (url: string, value: Json) => ({ url, ...value });
  return {
    url: COVERAGE_INFO,
    extension: [
      ext("coverage", { valueReference: { reference: coverage } }),
      ext("covered", { valueCode: rule?.covered ?? "conditional" }),
      ext("pa-needed", { valueCode: rule?.paNeeded ?? "auth-needed" }),
      ...(rule?.docNeeded ? [ext("doc-needed", { valueCode: rule.docNeeded })] : []),
      ...(rule?.questionnaire
        ? [ext("questionnaire", { valueCanonical: `${base}/Questionnaire/${rule.questionnaire}` })]
        : []),
      ext("date", { valueDate: new Date().toISOString().slice(0, 10) }),
      ext("coverage-assertion-id", { valueString: randomUUID() }),
    ],
  };
}

function crdResponse(body: Json, origin: string, base: string): Json {
  const orders = ((body.context?.draftOrders?.entry ?? []) as Json[]).map((e) => e.resource).filter(Boolean);
  const coverageEntry = (body.prefetch?.coverage?.entry ?? [])[0]?.resource ?? body.prefetch?.coverage;
  const coverage = coverageEntry?.id ? `Coverage/${coverageEntry.id}` : undefined;
  const source = { label: "Synthetic Health Plan coverage requirements", url: `${origin}/cds-services` };
  if (!coverage)
    return {
      cards: [
        {
          uuid: randomUUID(),
          summary: "No active coverage was sent, so coverage requirements cannot be checked",
          indicator: "warning",
          source,
        },
      ],
    };
  const cards: Json[] = [];
  const systemActions: Json[] = [];
  for (const order of orders) {
    const rule = ruleFor(orderCode(order));
    const updated = {
      ...order,
      extension: [
        ...((order.extension ?? []) as Json[]).filter((e) => e.url !== COVERAGE_INFO),
        coverageInformation(rule, coverage, base),
      ],
    };
    systemActions.push({ type: "update", description: "Add coverage information", resource: updated });
    cards.push({
      uuid: randomUUID(),
      summary: rule
        ? `${rule.display}: ${rule.note}`
        : "No coverage rule for this order; prior authorization is required",
      indicator: rule?.paNeeded === "auth-needed" ? "warning" : "info",
      source,
      ...(rule?.questionnaire
        ? {
            links: [
              {
                label: "Complete documentation (DTR)",
                url: `${base}/Questionnaire/${rule.questionnaire}`,
                type: "absolute",
              },
            ],
          }
        : {}),
    });
  }
  return { cards, systemActions };
}

// PAS: decide a Claim and build the ClaimResponse.
function decide(claim: Json, final: boolean): { response: Json; decisions: Decision[] } {
  const decisions = ((claim.item ?? []) as Json[]).map((item) => {
    const rule = ruleFor(item.productOrService?.coding?.find((c: Json) => c.system === HCPCS)?.code);
    if (!rule) return "pended" as Decision;
    return rule.decision === "pended" && final ? "approved" : rule.decision;
  });
  const pending = decisions.includes("pended");
  const approved = decisions.length > 0 && decisions.every((d) => d === "approved");
  const created = new Date().toISOString();
  const response: Json = {
    resourceType: "ClaimResponse",
    id: `claimresponse-${claim.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    identifier: claim.identifier,
    status: "active",
    type: claim.type,
    use: "preauthorization",
    patient: claim.patient,
    created,
    insurer: claim.insurer,
    requestor: claim.provider,
    request: { reference: `Claim/${claim.id}` },
    outcome: pending ? "queued" : decisions.every((d) => d === "denied") ? "error" : approved ? "complete" : "partial",
    disposition: pending
      ? "Pended for medical review; inquire again for the decision"
      : approved
        ? "Approved"
        : decisions.every((d) => d === "denied")
          ? "Denied"
          : "Partially approved",
    ...(approved
      ? { preAuthRef: `SYNPA-${claim.id}`.toUpperCase(), preAuthPeriod: { start: created.slice(0, 10) } }
      : {}),
    item: ((claim.item ?? []) as Json[]).map((item, i) => ({
      extension: [{ url: REVIEW_DECISION, valueCode: decisions[i] }],
      itemSequence: item.sequence ?? i + 1,
      adjudication: [
        {
          category: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "submitted" }] },
        },
      ],
    })),
  };
  return { response, decisions };
}

function readClaimBundle(body: unknown): { claim?: Json; entries: Json[]; error?: string } {
  const bundle = body as Json;
  if (bundle?.resourceType !== "Bundle") return { entries: [], error: "The body must be a PAS request Bundle" };
  const entries = ((bundle.entry ?? []) as Json[]).filter((e) => e.resource);
  const claim = entries.find((e) => e.resource.resourceType === "Claim")?.resource;
  if (!claim) return { entries, error: "The Bundle has no Claim" };
  if (claim.use !== "preauthorization") return { entries, error: "Claim.use must be preauthorization" };
  if (!claim.identifier?.length) return { entries, error: "The Claim needs an identifier" };
  return { claim, entries };
}

const responseBundle = (response: Json, entries: Json[]) => ({
  resourceType: "Bundle",
  id: randomUUID(),
  type: "collection",
  timestamp: new Date().toISOString(),
  entry: [
    { fullUrl: `urn:uuid:${randomUUID()}`, resource: response },
    ...entries.filter((e) => !["Claim", "ClaimResponse"].includes(e.resource.resourceType)),
  ],
});

export const priorauthPlugin: ServicePlugin = {
  name: "priorauth",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/$/, "");
    const base = `${origin}${FHIR_PATH}`;

    app.get("/cds-services", (c) =>
      c.json({
        services: ["order-sign", "order-select"].map((hook) => ({
          hook,
          id: `coverage-requirements-${hook}`,
          title: "Synthetic Health Plan coverage requirements",
          description: "Da Vinci CRD: coverage, prior authorization, and documentation requirements for draft orders.",
          prefetch: {
            patient: "Patient/{{context.patientId}}",
            coverage: "Coverage?patient={{context.patientId}}&status=active",
          },
        })),
      }),
    );
    app.post("/cds-services/:id", async (c) => {
      if (!/^coverage-requirements-(order-sign|order-select)$/.test(c.req.param("id")))
        return c.json({ error: "Unknown CDS service" }, 404);
      let body: Json;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "The body must be JSON" }, 400);
      }
      if (!body?.hookInstance || !body.context) return c.json({ error: "hookInstance and context are required" }, 400);
      return c.json(crdResponse(body, origin, base));
    });

    app.post(`${FHIR_PATH}/Questionnaire/$questionnaire-package`, async (c) => {
      const params = (await c.req.json().catch(() => undefined)) as Json | undefined;
      if (params?.resourceType !== "Parameters")
        return fhirJson(c, operationOutcome("invalid", "The body must be a Parameters resource"), 400);
      const part = (name: string) => (params.parameter ?? []).filter((p: Json) => p.name === name);
      if (!part("coverage").length)
        return fhirJson(c, operationOutcome("required", "A coverage parameter is required"), 400);
      const wanted = new Set<string>();
      for (const p of part("questionnaire")) wanted.add(String(p.valueCanonical).split("/").pop() ?? "");
      for (const p of part("order")) {
        const rule = ruleFor(orderCode(p.resource ?? {}));
        if (rule?.questionnaire) wanted.add(rule.questionnaire);
      }
      const fhir = getFhirStore(store);
      const found = [...wanted].map((id) => fhir.find("Questionnaire", id)).filter(Boolean) as FhirResource[];
      return fhirJson(c, {
        resourceType: "Parameters",
        parameter: found.map((q) => ({
          name: "PackageBundle",
          resource: {
            resourceType: "Bundle",
            type: "collection",
            entry: [{ fullUrl: `${base}/Questionnaire/${q.id}`, resource: q }],
          },
        })),
      });
    });

    app.post(`${FHIR_PATH}/Claim/$submit`, async (c) => {
      const { claim, entries, error } = readClaimBundle(await c.req.json().catch(() => undefined));
      if (!claim) return fhirJson(c, operationOutcome("invalid", error!), 400);
      const fhir = getFhirStore(store);
      const stored = { ...claim, id: claim.id ?? randomUUID() };
      fhir.update("Claim", stored.id, stored);
      const { response } = decide(stored, false);
      fhir.update("ClaimResponse", response.id, response);
      return fhirJson(c, responseBundle(response, entries));
    });

    app.post(`${FHIR_PATH}/Claim/$inquire`, async (c) => {
      const { claim, entries, error } = readClaimBundle(await c.req.json().catch(() => undefined));
      if (!claim) return fhirJson(c, operationOutcome("invalid", error!), 400);
      const fhir = getFhirStore(store);
      const id = claim.identifier[0];
      const stored = fhir
        .listCurrent("Claim")
        .find((x: Json) => (x.identifier ?? []).some((i: Json) => i.system === id.system && i.value === id.value)) as
        | Json
        | undefined;
      if (!stored)
        return fhirJson(c, operationOutcome("not-found", "No prior authorization request has that identifier"), 404);
      // A pended request is decided when the provider inquires.
      const { response } = decide(stored, true);
      fhir.update("ClaimResponse", response.id, response);
      return fhirJson(c, responseBundle(response, entries));
    });

    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: FHIR_PATH,
      software: { name: "emuhealth prior authorization emulator" },
      description: "A synthetic payer's Da Vinci DTR and PAS endpoints. Not affiliated with any payer.",
    });
  },
  seed(store: Store, baseUrl: string): void {
    seedQuestionnaires(store, baseUrl);
  },
};

export default priorauthPlugin;
