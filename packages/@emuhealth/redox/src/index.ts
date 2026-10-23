import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import {
  getFhirStore,
  seedFromConfig as seedFhirFromConfig,
  seedSyntheticRecords,
  seedTerminology,
  type FhirResource,
  type FhirSeedConfig,
} from "@emuhealth/fhir-core";

/**
 * Redox emulator (emuhealth is not affiliated with Redox): authentication, the /endpoint API for Redox JSON data
 * models (PatientAdmin, PatientSearch, ClinicalSummary, Scheduling, Results, Notes), and destination webhooks that
 * carry a verification token, with Redox's challenge handshake. Patients and clinical data come from the same
 * synthetic records as the FHIR server.
 */
export interface RedoxSeedConfig extends FhirSeedConfig {
  /** API keys and secrets accepted by /auth/authenticate and /v2/auth/token. Default: any non-empty pair. */
  sources?: Array<{ apiKey: string; secret: string }>;
  /** Destinations that receive EHR events, with the verification token Redox sends in the verification-token header. */
  destinations?: Array<{ url: string; verificationToken: string; dataModels?: string[] }>;
}

const DATA_KEY = "redox.data";
const OWNER = "redox";
const SERVICE_LABEL = "Redox";
const SOURCE = { ID: "5e7e0000-0000-4000-8000-0000000000aa", Name: "emuhealth synthetic EHR" };

interface RedoxData {
  sources: Array<{ apiKey: string; secret: string }>;
  tokens: Map<string, number>;
  refreshTokens: Set<string>;
  messages: Array<{
    id: string;
    at: string;
    direction: "inbound" | "outbound";
    dataModel: string;
    eventType: string;
    body: unknown;
    status?: number;
  }>;
  appointments: Array<Record<string, unknown>>;
}

function data(store: Store): RedoxData {
  let d = store.getData<RedoxData>(DATA_KEY);
  if (!d) {
    d = { sources: [], tokens: new Map(), refreshTokens: new Set(), messages: [], appointments: [] };
    store.setData(DATA_KEY, d);
  }
  return d;
}

const dispatchers = new WeakMap<Store, WebhookDispatcher>();

export function seedFromConfig(store: Store, baseUrl: string, config: RedoxSeedConfig): void {
  const { sources, destinations, ...fhirConfig } = config;
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.some((s) => !s?.apiKey || !s?.secret))
      throw new Error("redox.sources must be an array of { apiKey, secret }");
    data(store).sources = sources;
  }
  if (destinations !== undefined) {
    if (!Array.isArray(destinations)) throw new Error("redox.destinations must be an array");
    const webhooks = dispatchers.get(store);
    for (const sub of webhooks?.getSubscriptions(OWNER) ?? []) webhooks?.unregister(sub.id);
    for (const [i, d] of destinations.entries()) {
      if (!d || typeof d.url !== "string" || !/^https?:\/\//.test(d.url))
        throw new Error(`redox.destinations[${i}].url must be an http(s) URL`);
      if (typeof d.verificationToken !== "string" || !d.verificationToken)
        throw new Error(`redox.destinations[${i}].verificationToken is required`);
      webhooks?.register({
        url: d.url,
        events: d.dataModels ?? ["*"],
        active: true,
        secret: d.verificationToken,
        owner: OWNER,
      });
    }
  }
  seedFhirFromConfig(store, baseUrl, fhirConfig);
}

// Redox data model views of the synthetic FHIR records.

const refTo = (r: FhirResource, patientId: string) =>
  [
    (r.subject as { reference?: string } | undefined)?.reference,
    (r.patient as { reference?: string } | undefined)?.reference,
  ].includes(`Patient/${patientId}`);
const coding = (concept: unknown, system?: string) => {
  const codings =
    (concept as { coding?: Array<{ system?: string; code?: string; display?: string }> } | undefined)?.coding ?? [];
  return codings.find((c) => !system || c.system === system) ?? codings[0];
};
const text = (concept: unknown) => (concept as { text?: string } | undefined)?.text ?? coding(concept)?.display ?? "";
const CODESETS: Record<string, string> = {
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RxNorm",
  "http://loinc.org": "LOINC",
  "http://hl7.org/fhir/sid/cvx": "CVX",
};

export function redoxPatient(p: FhirResource): Record<string, unknown> {
  const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
  const address = (p.address as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const mrn = (p.identifier as Array<{ value?: string }> | undefined)?.[0]?.value;
  const phone = (p.telecom as Array<{ system?: string; value?: string }> | undefined)?.find(
    (t) => t.system === "phone",
  )?.value;
  return {
    Identifiers: [...(mrn ? [{ ID: mrn, IDType: "MR" }] : []), { ID: p.id, IDType: "EHRID" }],
    Demographics: {
      FirstName: name.given?.[0] ?? null,
      MiddleName: null,
      LastName: name.family ?? null,
      DOB: p.birthDate ?? null,
      SSN: null,
      Sex: p.gender === "female" ? "Female" : p.gender === "male" ? "Male" : "Unknown",
      Race: null,
      IsHispanic: null,
      MaritalStatus: null,
      IsDeceased: false,
      DeathDateTime: null,
      PhoneNumber: { Home: phone ?? null, Office: null, Mobile: null },
      EmailAddresses: [],
      Language: "en",
      Citizenship: [],
      Address: {
        StreetAddress: ((address.line as string[] | undefined) ?? [])[0] ?? null,
        City: address.city ?? null,
        State: address.state ?? null,
        ZIP: address.postalCode ?? null,
        County: null,
        Country: address.country ?? "US",
      },
    },
    Notes: [],
  };
}

function clinicalSummary(store: Store, p: FhirResource): Record<string, unknown> {
  const fhir = getFhirStore(store);
  const of = (type: string) => fhir.listCurrent(type).filter((r) => refTo(r, p.id!));
  const code = (concept: unknown) => {
    const c = coding(concept);
    return {
      Code: c?.code ?? null,
      CodeSystem: null,
      CodeSystemName: (c?.system && CODESETS[c.system]) ?? null,
      Name: text(concept) || null,
    };
  };
  return {
    Header: {
      DocumentType: "Continuity of Care Document",
      Patient: redoxPatient(p),
      Author: {
        ID: null,
        Type: null,
        FirstName: null,
        LastName: null,
        Credentials: [],
        Address: {},
        Location: { Department: null, Facility: SOURCE.Name },
      },
    },
    Problems: of("Condition").map((c) => ({
      StartDate: c.onsetDateTime ?? null,
      EndDate: null,
      ...code(c.code),
      Category: { Code: null, CodeSystemName: null, Name: "Problem" },
      Status: { Name: "Active" },
    })),
    Medications: of("MedicationRequest").map((m) => ({
      StartDate: m.authoredOn ?? null,
      EndDate: null,
      Product: code(m.medicationCodeableConcept),
      Dose: { Quantity: null, Units: null },
      Route: null,
      Frequency: { Period: null, Unit: null },
      Prescription: false,
      FreeTextSig: (m.dosageInstruction as Array<{ text?: string }> | undefined)?.[0]?.text ?? null,
    })),
    Allergies: of("AllergyIntolerance").map((a) => ({
      Type: { Name: ((a.category as string[] | undefined) ?? [])[0] ?? null },
      Substance: code(a.code),
      Reaction: [],
      Severity: { Name: a.criticality ?? null },
      Status: { Name: "Active" },
      StartDate: a.recordedDate ?? null,
    })),
    Immunizations: of("Immunization").map((i) => ({
      DateTime: i.occurrenceDateTime ?? null,
      Product: code(i.vaccineCode),
    })),
    VitalSigns: of("Observation")
      .filter((o) => coding((o.category as unknown[] | undefined)?.[0])?.code === "vital-signs" && o.valueQuantity)
      .map((o) => ({
        DateTime: o.effectiveDateTime ?? null,
        Observations: [
          {
            ...code(o.code),
            Status: "Final",
            Value: String((o.valueQuantity as { value?: number }).value ?? ""),
            ValueType: "Numeric",
            Units: (o.valueQuantity as { unit?: string }).unit ?? null,
            DateTime: o.effectiveDateTime ?? null,
          },
        ],
      })),
  };
}

type AnyContext = Context<AppEnv>;
type Message = Record<string, unknown> & { Meta?: Record<string, unknown> };

class RedoxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function findPatient(store: Store, patient: unknown): FhirResource | undefined {
  const fhir = getFhirStore(store);
  const ids = ((patient as { Identifiers?: Array<{ ID?: string }> } | undefined)?.Identifiers ?? []).map((i) =>
    String(i.ID),
  );
  const demographics = ((patient as { Demographics?: Record<string, string> } | undefined)?.Demographics ??
    {}) as Record<string, string>;
  return fhir.listCurrent("Patient").find((p) => {
    const view = redoxPatient(p) as { Identifiers: Array<{ ID: string }>; Demographics: Record<string, string> };
    if (ids.length) return view.Identifiers.some((i) => ids.includes(String(i.ID)));
    const fields = ["FirstName", "LastName", "DOB", "Sex"].filter((f) => demographics[f]);
    return (
      fields.length > 0 &&
      fields.every((f) => String(view.Demographics[f] ?? "").toLowerCase() === String(demographics[f]).toLowerCase())
    );
  });
}

export const redoxPlugin: ServicePlugin = {
  name: "redox",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, _baseUrl: string, _tokenMap?: TokenMap): void {
    dispatchers.set(store, webhooks);
    // Redox sends the destination's verification token in a header with every event.
    webhooks.setHeaderFactory(({ subscription }) => ({
      "Content-Type": "application/json",
      ...(subscription.secret ? { "verification-token": subscription.secret } : {}),
    }));

    const issue = () => {
      const accessToken = randomBytes(24).toString("hex");
      const refreshToken = randomBytes(24).toString("hex");
      data(store).tokens.set(accessToken, Date.now() + 24 * 3600_000);
      data(store).refreshTokens.add(refreshToken);
      return { accessToken, refreshToken, expires: new Date(Date.now() + 24 * 3600_000).toISOString() };
    };
    const knownSource = (apiKey: string, secret: string) => {
      const sources = data(store).sources;
      return sources.length === 0
        ? Boolean(apiKey && secret)
        : sources.some((s) => s.apiKey === apiKey && s.secret === secret);
    };

    // Legacy API key authentication.
    app.post("/auth/authenticate", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; secret?: string };
      if (!knownSource(body.apiKey ?? "", body.secret ?? "")) return c.text("Invalid request", 401);
      return c.json(issue());
    });
    app.post("/auth/refreshToken", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; refreshToken?: string };
      if (!body.refreshToken || !data(store).refreshTokens.has(body.refreshToken))
        return c.text("Invalid request", 401);
      data(store).refreshTokens.delete(body.refreshToken);
      return c.json(issue());
    });
    // OAuth 2.0 client credentials.
    app.post("/v2/auth/token", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      if (form.get("grant_type") !== "client_credentials") return c.json({ error: "unsupported_grant_type" }, 400);
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
      const [id, secret] = basic
        ? Buffer.from(basic[1], "base64").toString("utf8").split(":")
        : [form.get("client_id") ?? "", form.get("client_secret") ?? ""];
      const assertion = form.get("client_assertion");
      if (!assertion && !knownSource(id ?? "", secret ?? "")) return c.json({ error: "invalid_client" }, 401);
      const { accessToken } = issue();
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 86400,
        scope: form.get("scope") ?? "",
      });
    });

    const authorized = (c: AnyContext) => {
      const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const expires = token ? data(store).tokens.get(token) : undefined;
      return expires !== undefined && expires > Date.now();
    };

    const reply = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      Meta: {
        ...meta,
        Message: { ID: Math.floor(Math.random() * 1e9) },
        Transmission: { ID: Math.floor(Math.random() * 1e9) },
        Source: SOURCE,
        Errors: [],
      },
      ...extra,
    });

    function handle(message: Message): { status: number; body: unknown } {
      const meta = message.Meta ?? {};
      const model = String(meta.DataModel ?? "");
      const event = String(meta.EventType ?? "");
      if (!model || !event) throw new RedoxError(400, "Meta.DataModel and Meta.EventType are required");
      const fhir = getFhirStore(store);
      switch (`${model}.${event}`) {
        case "PatientSearch.Query": {
          const patient = findPatient(store, message.Patient);
          return { status: 200, body: reply(meta, { Patient: patient ? redoxPatient(patient) : null }) };
        }
        case "ClinicalSummary.PatientQuery": {
          const patient = findPatient(store, message.Patient);
          if (!patient) throw new RedoxError(400, "No patient matches the identifiers in Patient.Identifiers");
          return { status: 200, body: { Meta: reply(meta).Meta, ...clinicalSummary(store, patient) } };
        }
        case "PatientAdmin.NewPatient":
        case "PatientAdmin.PatientUpdate": {
          const patient = message.Patient as
            | { Identifiers?: Array<{ ID?: string; IDType?: string }>; Demographics?: Record<string, unknown> }
            | undefined;
          const demographics = patient?.Demographics ?? {};
          if (!demographics.FirstName || !demographics.LastName)
            throw new RedoxError(400, "Patient.Demographics.FirstName and LastName are required");
          const existing = findPatient(store, { Identifiers: patient?.Identifiers });
          if (event === "PatientUpdate" && !existing)
            throw new RedoxError(400, "No patient matches the identifiers in Patient.Identifiers");
          const id = existing?.id ?? `redox-${randomUUID().slice(0, 8)}`;
          const sex = String(demographics.Sex ?? "").toLowerCase();
          const address = (demographics.Address ?? {}) as Record<string, string | null>;
          fhir.update("Patient", id, {
            ...(existing ?? {}),
            resourceType: "Patient",
            id,
            identifier: (patient?.Identifiers ?? [])
              .filter((i) => i.IDType !== "EHRID")
              .map((i) => ({ system: `urn:emuhealth:redox:${String(i.IDType ?? "id").toLowerCase()}`, value: i.ID })),
            name: [{ family: demographics.LastName, given: [demographics.FirstName] }],
            ...(sex ? { gender: ["female", "male"].includes(sex) ? sex : "unknown" } : {}),
            ...(demographics.DOB ? { birthDate: String(demographics.DOB).slice(0, 10) } : {}),
            ...(address.City
              ? {
                  address: [
                    {
                      line: address.StreetAddress ? [address.StreetAddress] : [],
                      city: address.City,
                      state: address.State,
                      postalCode: address.ZIP,
                      country: address.Country ?? "US",
                    },
                  ],
                }
              : {}),
          });
          return { status: 200, body: reply(meta) };
        }
        case "Scheduling.New":
        case "Scheduling.Reschedule":
        case "Scheduling.Cancel": {
          const visit = (message.Visit ?? {}) as Record<string, unknown>;
          const visitNumber = String(visit.VisitNumber ?? "");
          if (!visitNumber) throw new RedoxError(400, "Visit.VisitNumber is required");
          const existing = data(store).appointments.find((a) => a.VisitNumber === visitNumber);
          if (event === "New") {
            if (!findPatient(store, message.Patient))
              throw new RedoxError(400, "No patient matches the identifiers in Patient.Identifiers");
            if (existing) throw new RedoxError(400, `Visit ${visitNumber} already exists`);
            data(store).appointments.push({ ...visit, Patient: message.Patient, Status: "Scheduled" });
          } else {
            if (!existing) throw new RedoxError(400, `Visit ${visitNumber} does not exist`);
            Object.assign(existing, visit, { Status: event === "Cancel" ? "Canceled" : "Rescheduled" });
          }
          return { status: 200, body: reply(meta) };
        }
        case "Results.New":
        case "Notes.New":
        case "Media.New":
          if (!findPatient(store, message.Patient))
            throw new RedoxError(400, "No patient matches the identifiers in Patient.Identifiers");
          return { status: 200, body: reply(meta) };
        default:
          throw new RedoxError(400, `The emulator does not support ${model} ${event}`);
      }
    }

    app.post("/endpoint", async (c) => {
      if (!authorized(c)) return c.text("Invalid request", 401);
      let message: Message;
      try {
        message = (await c.req.json()) as Message;
      } catch {
        return c.json(
          { Meta: { Errors: [{ ID: 1, Text: "The body must be JSON", Type: "message", Module: "Send" }] } },
          400,
        );
      }
      const meta = message.Meta ?? {};
      try {
        const { status, body } = handle(message);
        data(store).messages.unshift({
          id: randomUUID(),
          at: new Date().toISOString(),
          direction: "inbound",
          dataModel: String(meta.DataModel),
          eventType: String(meta.EventType),
          body: message,
          status,
        });
        data(store).messages.splice(200);
        return c.json(body, status as never);
      } catch (err) {
        if (!(err instanceof RedoxError)) throw err;
        data(store).messages.unshift({
          id: randomUUID(),
          at: new Date().toISOString(),
          direction: "inbound",
          dataModel: String(meta.DataModel ?? ""),
          eventType: String(meta.EventType ?? ""),
          body: message,
          status: err.status,
        });
        return c.json(
          { Meta: { ...meta, Errors: [{ ID: 1, Text: err.message, Type: "message", Module: "Send" }] } },
          err.status as never,
        );
      }
    });

    /** Build an EHR event for a patient and deliver it to destinations, the way Redox forwards EHR messages. */
    async function sendEvent(
      dataModel: string,
      eventType: string,
      patientId: string,
    ): Promise<Record<string, unknown>> {
      const patient = getFhirStore(store).find("Patient", patientId);
      if (!patient) throw new RedoxError(400, `Patient ${patientId} is not known`);
      const meta = {
        DataModel: dataModel,
        EventType: eventType,
        EventDateTime: new Date().toISOString(),
        Test: true,
        Source: SOURCE,
        Destinations: [],
        Message: { ID: Math.floor(Math.random() * 1e9) },
        Transmission: { ID: Math.floor(Math.random() * 1e9) },
      };
      let body: Record<string, unknown> = { Meta: meta, Patient: redoxPatient(patient) };
      if (dataModel === "Results") {
        const labs = getFhirStore(store)
          .listCurrent("Observation")
          .filter(
            (o) => refTo(o, patientId) && coding((o.category as unknown[] | undefined)?.[0])?.code === "laboratory",
          );
        body = {
          ...body,
          Orders: [
            {
              ID: `SYN-ORD-${patientId}`,
              Status: "Resulted",
              Results: labs.map((o) => ({
                Code: coding(o.code)?.code ?? null,
                Codeset: "LOINC",
                Description: text(o.code),
                Value: String((o.valueQuantity as { value?: number } | undefined)?.value ?? ""),
                ValueType: "Numeric",
                Units: (o.valueQuantity as { unit?: string } | undefined)?.unit ?? null,
                Status: "Final",
                CompletionDateTime: o.effectiveDateTime ?? null,
              })),
            },
          ],
        };
      }
      if (dataModel === "Scheduling")
        body = {
          ...body,
          Visit: {
            VisitNumber: `SYN-VISIT-${Date.now()}`,
            VisitDateTime: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            Duration: 30,
            Reason: "Synthetic follow-up",
            Location: { Facility: SOURCE.Name },
          },
        };
      data(store).messages.unshift({
        id: randomUUID(),
        at: new Date().toISOString(),
        direction: "outbound",
        dataModel,
        eventType,
        body,
      });
      await webhooks.dispatch(dataModel, eventType, body, OWNER);
      return body;
    }

    // Trigger an EHR event from code: POST /ehr/send { DataModel, EventType, patientId }.
    app.post("/ehr/send", async (c) => {
      const input = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      try {
        const body = await sendEvent(
          input.DataModel ?? "PatientAdmin",
          input.EventType ?? "NewPatient",
          input.patientId ?? "syn-patient-001",
        );
        return c.json({ sent: body, deliveries: webhooks.getDeliveries().slice(-10) });
      } catch (err) {
        if (err instanceof RedoxError) return c.json({ error: err.message }, err.status as never);
        throw err;
      }
    });

    // Destination verification: Redox calls your endpoint with the challenge and expects it back.
    app.post("/ehr/verify", async (c) => {
      const input = (await c.req.json().catch(() => ({}))) as { url?: string; verificationToken?: string };
      if (!input.url || !input.verificationToken)
        return c.json({ error: "url and verificationToken are required" }, 400);
      const challenge = randomBytes(8).toString("hex");
      try {
        const res = await fetch(
          `${input.url}${input.url.includes("?") ? "&" : "?"}${new URLSearchParams({ challenge, "verification-token": input.verificationToken })}`,
          {
            method: "POST",
            headers: { "verification-token": input.verificationToken, "Content-Type": "application/json" },
            body: JSON.stringify({ challenge, "verification-token": input.verificationToken }),
          },
        );
        const text = (await res.text()).trim();
        return c.json({
          verified: res.ok && text.replace(/^"|"$/g, "") === challenge,
          status: res.status,
          challenge,
          response: text,
        });
      } catch (err) {
        return c.json({ verified: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get("/_inspector", (c) => {
      const tab = c.req.query("tab") === "appointments" ? "appointments" : "messages";
      const tabs = [
        { id: "messages", label: `Messages (${data(store).messages.length})`, href: "/_inspector" },
        {
          id: "appointments",
          label: `Appointments (${data(store).appointments.length})`,
          href: "/_inspector?tab=appointments",
        },
      ];
      const rows =
        tab === "messages"
          ? data(store).messages.map(
              (m) =>
                `<tr><td>${escapeHtml(m.at)}</td><td>${m.direction}</td><td>${escapeHtml(m.dataModel)}</td><td>${escapeHtml(m.eventType)}</td><td>${m.status ?? ""}</td></tr>`,
            )
          : data(store).appointments.map(
              (a) =>
                `<tr><td>${escapeHtml(String(a.VisitNumber))}</td><td>${escapeHtml(String(a.VisitDateTime ?? ""))}</td><td>${escapeHtml(String(a.Status))}</td></tr>`,
            );
      const head =
        tab === "messages" ? ["time", "direction", "data model", "event", "status"] : ["visit", "time", "status"];
      const send = `<form method="post" action="/_inspector/send"><label class="inspector-field">Event<select name="event">${["PatientAdmin.NewPatient", "PatientAdmin.PatientUpdate", "Results.New", "Scheduling.New"].map((e) => `<option value="${escapeAttr(e)}">${escapeHtml(e)}</option>`).join("")}</select></label><label class="inspector-field">Patient<select name="patientId">${getFhirStore(
        store,
      )
        .listCurrent("Patient")
        .map((p) => `<option value="${escapeAttr(p.id!)}">${escapeHtml(p.id!)}</option>`)
        .join("")}</select></label><button type="submit" class="inspector-action">Send to destinations</button></form>`;
      const body = `<div class="inspector-section"><h2>Send an EHR event</h2>${send}</div><div class="inspector-section"><h2>${tab === "messages" ? "Messages" : "Appointments"}</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
        rows.length
          ? rows.join("")
          : `<tr><td colspan="${head.length}"><div class="inspector-empty">Nothing yet</div></td></tr>`
      }</tbody></table></div></div>`;
      return c.html(renderInspectorPage("Redox inspector", tabs, tab, body, SERVICE_LABEL));
    });
    app.post("/_inspector/send", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const [dataModel, eventType] = (form.get("event") ?? "PatientAdmin.NewPatient").split(".");
      await sendEvent(dataModel, eventType, form.get("patientId") ?? "syn-patient-001").catch(() => undefined);
      return c.redirect("/_inspector", 303);
    });
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
  },
};

export default redoxPlugin;
