import { randomBytes } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  SYNTHETIC_TAG,
  getFhirStore,
  issueSmartToken,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedSyntheticRecords,
  seedTerminology,
  type FhirResource,
  type FhirSeedConfig,
  type FhirStore,
} from "@emuhealth/fhir-core";

/**
 * athenahealth emulator (emuhealth is not affiliated with athenahealth): the proprietary REST API under
 * /v1/{practiceid} (patients, departments, providers, chart problems, allergies, medications, vitals, and
 * appointments) and FHIR R4 under /fhir/r4 with the ah-practice parameter, both over the same synthetic records,
 * behind OAuth 2.0 client credentials at /oauth2/v1/token.
 */

/** athenahealth's documented preview practice id, so code written against the preview works unchanged. */
export const DEFAULT_PRACTICE_ID = "195900";
export const ATHENA_FHIR_PATH = "/fhir/r4";

export interface AthenaSeedConfig extends FhirSeedConfig {
  /** Practice ids the API accepts. Default ["195900"]. */
  practiceIds?: string[];
  /** Open appointment slots: weekdays from startDate (YYYY-MM-DD, default today). */
  scheduling?: { startDate?: string; days?: number };
}

const DATA_KEY = "athena.data";
const DAY = 86_400_000;

interface AthenaData {
  practiceIds: string[];
  tokens: Set<string>;
  appointments: Array<Record<string, string>>;
  nextPatientId: number;
}

function data(store: Store): AthenaData {
  let d = store.getData<AthenaData>(DATA_KEY);
  if (!d) {
    d = { practiceIds: [DEFAULT_PRACTICE_ID], tokens: new Set(), appointments: [], nextPatientId: 1 };
    store.setData(DATA_KEY, d);
  }
  return d;
}

/** athenahealth dates are MM/DD/YYYY. */
const athenaDate = (iso: string) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");
const isoDate = (mmddyyyy: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mmddyyyy);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined;
};

/** Numeric athenahealth ids for FHIR resources: syn-patient-003 is patient 3. */
const numericId = (id: string) => String(Number(id.match(/(\d+)$/)?.[1] ?? 0));

function seedAppointments(store: Store, options: AthenaSeedConfig["scheduling"] = {}): void {
  const fhir = getFhirStore(store);
  const start = options.startDate ? Date.parse(`${options.startDate}T00:00:00Z`) : Math.floor(Date.now() / DAY) * DAY;
  if (Number.isNaN(start)) throw new Error("athena.scheduling.startDate must be a date in YYYY-MM-DD form");
  const days = options.days ?? 10;
  if (!Number.isInteger(days) || days < 0 || days > 60)
    throw new Error("athena.scheduling.days must be an integer from 0 to 60");
  const appointments: Array<Record<string, string>> = [];
  let id = 1000;
  const providers = fhir.listCurrent("Practitioner");
  for (let day = start, added = 0; added < days; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    added++;
    for (const provider of providers)
      for (let minute = 9 * 60; minute < 16 * 60; minute += 30) {
        const hh = String(Math.floor(minute / 60)).padStart(2, "0");
        const mm = String(minute % 60).padStart(2, "0");
        appointments.push({
          appointmentid: String(++id),
          appointmentstatus: "o",
          date: athenaDate(new Date(day).toISOString().slice(0, 10)),
          starttime: `${hh}:${mm}`,
          duration: "30",
          departmentid: "1",
          providerid: numericId(provider.id!),
          appointmenttypeid: "2",
          appointmenttype: "Office Visit",
          patientappointmenttypename: "Office Visit",
        });
      }
  }
  data(store).appointments = appointments;
}

export function seedFromConfig(store: Store, baseUrl: string, config: AthenaSeedConfig): void {
  const { practiceIds, scheduling, ...fhirConfig } = config;
  if (practiceIds !== undefined) {
    if (!Array.isArray(practiceIds) || practiceIds.some((p) => typeof p !== "string" || !/^\d+$/.test(p)))
      throw new Error("athena.practiceIds must be an array of numeric strings");
    data(store).practiceIds = practiceIds;
  }
  seedFhirFromConfig(store, baseUrl, fhirConfig);
  seedAppointments(store, scheduling);
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AnyContext = Context<AppEnv>;

// Proprietary views of FHIR resources.

function patientView(p: FhirResource, departmentid = "1"): Record<string, string> {
  const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
  const address = (p.address as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const phone = (p.telecom as Array<{ system?: string; value?: string }> | undefined)?.find(
    (t) => t.system === "phone",
  );
  return {
    patientid: numericId(p.id!),
    firstname: name.given?.[0] ?? "",
    lastname: name.family ?? "",
    sex: p.gender === "female" ? "F" : p.gender === "male" ? "M" : "",
    dob: athenaDate(String(p.birthDate ?? "")),
    homephone: (phone?.value ?? "").replace(/\D/g, ""),
    address1: ((address.line as string[] | undefined) ?? [])[0] ?? "",
    city: String(address.city ?? "").toUpperCase(),
    state: String(address.state ?? ""),
    zip: String(address.postalCode ?? ""),
    countrycode3166: "US",
    departmentid,
    primarydepartmentid: departmentid,
    status: p.active === false ? "inactive" : "active",
    registrationdate: athenaDate(
      String((p.meta as { lastUpdated?: string } | undefined)?.lastUpdated ?? "").slice(0, 10),
    ),
  };
}

const conceptText = (c: unknown) =>
  (c as { text?: string; coding?: Array<{ display?: string }> } | undefined)?.text ??
  (c as { coding?: Array<{ display?: string }> } | undefined)?.coding?.[0]?.display ??
  "";
const conceptCode = (c: unknown, system: string) =>
  (c as { coding?: Array<{ system?: string; code?: string }> } | undefined)?.coding?.find((x) => x.system === system)
    ?.code ?? "";

function patientRecords(fhir: FhirStore, type: string, patientFhirId: string): FhirResource[] {
  const ref = `Patient/${patientFhirId}`;
  return fhir
    .listCurrent(type)
    .filter(
      (r) =>
        (r.subject as { reference?: string } | undefined)?.reference === ref ||
        (r.patient as { reference?: string } | undefined)?.reference === ref,
    );
}

/** athenahealth lists: { <key>: [...], totalcount, next } with offset and limit paging. */
function list(c: AnyContext, key: string, items: unknown[]): Response {
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 1500) || 1500, 1), 5000);
  const page = items.slice(offset, offset + limit);
  const url = new URL(c.req.url);
  let next: string | undefined;
  if (offset + limit < items.length) {
    url.searchParams.set("offset", String(offset + limit));
    next = `${url.pathname}${url.search}`;
  }
  return c.json({ [key]: page, totalcount: items.length, ...(next ? { next } : {}) });
}

export const athenaPlugin: ServicePlugin = {
  name: "athena",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const fhir = () => getFhirStore(store);
    const run = async (c: AnyContext, handler: () => Response | Promise<Response>) => {
      try {
        return await handler();
      } catch (err) {
        if (err instanceof ApiError) return c.json({ error: err.message }, err.status as never);
        throw err;
      }
    };

    // OAuth 2.0 client credentials (two-legged), Basic auth with any client id and secret.
    app.post("/oauth2/v1/token", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
      const [clientId, secret] = basic
        ? Buffer.from(basic[1], "base64").toString("utf8").split(":")
        : [form.get("client_id"), form.get("client_secret")];
      if (!clientId || !secret)
        return c.json({ error: "invalid_client", detailedmessage: "Client authentication failed" }, 401);
      if (form.get("grant_type") !== "client_credentials")
        return c.json({ error: "unsupported_grant_type", detailedmessage: "Use grant_type=client_credentials" }, 400);
      const token = randomBytes(18).toString("base64url");
      data(store).tokens.add(token);
      // The same token reads and writes the FHIR API, held to the requested SMART system scopes if any.
      const requested = form.get("scope") ?? "athena/service/Athenanet.MDP.*";
      const smartScopes = requested
        .split(/\s+/)
        .filter((s) => s.startsWith("system/"))
        .join(" ");
      issueSmartToken(store, { token, clientId, scope: smartScopes || "system/*.*", expiresAt: Date.now() + 3600_000 });
      return c.json({ access_token: token, token_type: "Bearer", expires_in: "3600", scope: requested });
    });

    const authorized = (c: AnyContext) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      return Boolean(bearer && data(store).tokens.has(bearer));
    };

    // Proprietary REST API

    app.use("/v1/:practiceid/:rest{.*}", async (c, next) => {
      if (!authorized(c)) return c.json({ error: "Unauthorized" }, 401);
      if (!data(store).practiceIds.includes(c.req.param("practiceid")))
        return c.json({ error: "Invalid practice." }, 404);
      return next();
    });

    const patientFhirId = (patientid: string) => {
      const match = fhir()
        .listCurrent("Patient")
        .find((p) => numericId(p.id!) === patientid);
      if (!match) throw new ApiError(404, "The patient is not valid.");
      return match;
    };

    app.get("/v1/:practiceid/departments", (c) =>
      list(c, "departments", [
        {
          departmentid: "1",
          name: "SYNTHETIC HEALTH CLINIC",
          address: "100 MAIN ST",
          city: "SPRINGFIELD",
          state: "IL",
          zip: "62701",
          phone: "5550100",
          timezonename: "America/Chicago",
          patientdepartmentname: "Synthetic Health Clinic",
        },
      ]),
    );

    app.get("/v1/:practiceid/providers", (c) =>
      list(
        c,
        "providers",
        fhir()
          .listCurrent("Practitioner")
          .map((p) => {
            const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
            const npi = (p.identifier as Array<{ system?: string; value?: string }> | undefined)?.find((i) =>
              i.system?.includes("us-npi"),
            );
            return {
              providerid: numericId(p.id!),
              firstname: name.given?.[0] ?? "",
              lastname: name.family ?? "",
              displayname: `${name.given?.[0] ?? ""} ${name.family ?? ""}`.trim(),
              specialty: "Family Medicine",
              providertype: "MD",
              ...(npi?.value ? { npi: npi.value } : {}),
            };
          }),
      ),
    );

    app.get("/v1/:practiceid/patients", (c) =>
      run(c, () => {
        const q = (name: string) => c.req.query(name)?.trim();
        const criteria = ["firstname", "lastname", "dob", "homephone", "guarantorfirstname"].filter((n) => q(n));
        if (!criteria.length) throw new ApiError(400, "Additional fields are required: firstname, lastname, or dob.");
        const dob = q("dob") ? isoDate(q("dob")!) : undefined;
        if (q("dob") && !dob) throw new ApiError(400, "The dob must be in mm/dd/yyyy format.");
        const patients = fhir()
          .listCurrent("Patient")
          .map((p) => ({ p, view: patientView(p, q("departmentid") ?? "1") }))
          .filter(({ p, view }) => {
            if (q("firstname") && view.firstname.toLowerCase() !== q("firstname")!.toLowerCase()) return false;
            if (q("lastname") && view.lastname.toLowerCase() !== q("lastname")!.toLowerCase()) return false;
            if (dob && p.birthDate !== dob) return false;
            if (q("homephone") && view.homephone !== q("homephone")!.replace(/\D/g, "")) return false;
            return true;
          })
          .map(({ view }) => view);
        return list(c, "patients", patients);
      }),
    );

    app.get("/v1/:practiceid/patients/:patientid", (c) =>
      run(c, () => c.json([patientView(patientFhirId(c.req.param("patientid")), c.req.query("departmentid") ?? "1")])),
    );

    app.post("/v1/:practiceid/patients", (c) =>
      run(c, async () => {
        const form = new URLSearchParams(await c.req.text());
        for (const field of ["firstname", "lastname", "dob", "departmentid"])
          if (!form.get(field)) throw new ApiError(400, `Additional fields are required: ${field}.`);
        const dob = isoDate(form.get("dob")!);
        if (!dob) throw new ApiError(400, "The dob must be in mm/dd/yyyy format.");
        const existing = fhir()
          .listCurrent("Patient")
          .map((p) => Number(numericId(p.id!)));
        const id = `syn-patient-${String(Math.max(0, ...existing) + 1).padStart(3, "0")}`;
        const sex = form.get("sex");
        fhir().update("Patient", id, {
          resourceType: "Patient",
          id,
          meta: { tag: [SYNTHETIC_TAG] },
          active: true,
          name: [{ use: "official", family: form.get("lastname"), given: [form.get("firstname")] }],
          ...(sex ? { gender: sex === "F" ? "female" : sex === "M" ? "male" : "unknown" } : {}),
          birthDate: dob,
          ...(form.get("homephone")
            ? { telecom: [{ system: "phone", value: form.get("homephone"), use: "home" }] }
            : {}),
          ...(form.get("zip")
            ? {
                address: [
                  {
                    line: [form.get("address1") ?? ""],
                    city: form.get("city") ?? "",
                    state: form.get("state") ?? "",
                    postalCode: form.get("zip"),
                  },
                ],
              }
            : {}),
        });
        return c.json([{ patientid: numericId(id) }]);
      }),
    );

    const chart = (path: string, key: string, build: (patient: FhirResource) => unknown[]) =>
      app.get(`/v1/:practiceid/chart/:patientid/${path}`, (c) =>
        run(c, () => {
          if (!c.req.query("departmentid")) throw new ApiError(400, "Additional fields are required: departmentid.");
          return list(c, key, build(patientFhirId(c.req.param("patientid"))));
        }),
      );

    chart("problems", "problems", (p) =>
      patientRecords(fhir(), "Condition", p.id!).map((r) => ({
        problemid: numericId(r.id!),
        name: conceptText(r.code),
        code: conceptCode(r.code, "http://hl7.org/fhir/sid/icd-10-cm"),
        codeset: "ICD10",
        events: [
          {
            eventtype: "START",
            onsetdate: athenaDate(String(r.onsetDateTime ?? "")),
            source: "ENCOUNTER",
            status: "CHRONIC",
          },
        ],
      })),
    );
    chart("allergies", "allergies", (p) =>
      patientRecords(fhir(), "AllergyIntolerance", p.id!).map((r) => ({
        allergenid: numericId(r.id!),
        allergenname: conceptText(r.code),
        criticality: String(r.criticality ?? ""),
        onsetdate: athenaDate(String(r.recordedDate ?? "")),
        reactions: ((r.reaction as Array<{ manifestation?: unknown[] }> | undefined) ?? []).flatMap((x) =>
          (x.manifestation ?? []).map((m) => ({ reactionname: conceptText(m) })),
        ),
      })),
    );
    chart("medications", "medications", (p) => [
      patientRecords(fhir(), "MedicationRequest", p.id!).map((r) => ({
        medicationid: numericId(r.id!),
        medication: conceptText(r.medicationCodeableConcept),
        rxnorm: conceptCode(r.medicationCodeableConcept, "http://www.nlm.nih.gov/research/umls/rxnorm"),
        unstructuredsig: (r.dosageInstruction as Array<{ text?: string }> | undefined)?.[0]?.text ?? "",
        createddate: athenaDate(String(r.authoredOn ?? "")),
        source: "SYNTHETIC",
        status: String(r.status ?? ""),
      })),
    ]);
    chart("vitals", "vitals", (p) => {
      const byCode = new Map<string, Array<Record<string, string>>>();
      for (const o of patientRecords(fhir(), "Observation", p.id!)) {
        const category = ((o.category as Array<{ coding?: Array<{ code?: string }> }> | undefined) ?? [])[0]
          ?.coding?.[0]?.code;
        if (category !== "vital-signs") continue;
        const name = conceptText(o.code);
        const value = (o.valueQuantity as { value?: number; unit?: string } | undefined) ?? {};
        const readings = byCode.get(name) ?? [];
        readings.push({
          readingid: numericId(o.id!) || String(readings.length + 1),
          clinicalelementid: `VITALS.${name.toUpperCase().replace(/[^A-Z]+/g, "")}`,
          value: value.value === undefined ? "" : String(value.value),
          unit: value.unit ?? "",
          readingtaken: athenaDate(String(o.effectiveDateTime ?? "").slice(0, 10)),
        });
        byCode.set(name, readings);
      }
      return [...byCode].map(([key, readings]) => ({ key, readings: [readings] }));
    });

    // Appointments

    const inRange = (date: string, c: AnyContext) => {
      const iso = isoDate(date)!;
      const start = c.req.query("startdate") ? isoDate(c.req.query("startdate")!) : undefined;
      const end = c.req.query("enddate") ? isoDate(c.req.query("enddate")!) : undefined;
      return (!start || iso >= start) && (!end || iso <= end);
    };
    app.get("/v1/:practiceid/appointments/open", (c) =>
      run(c, () => {
        if (!c.req.query("departmentid")) throw new ApiError(400, "Additional fields are required: departmentid.");
        const provider = c.req.query("providerid");
        return list(
          c,
          "appointments",
          data(store).appointments.filter(
            (a) =>
              a.appointmentstatus === "o" &&
              a.departmentid === c.req.query("departmentid") &&
              (!provider || a.providerid === provider) &&
              inRange(a.date, c),
          ),
        );
      }),
    );
    app.get("/v1/:practiceid/appointments/booked", (c) =>
      run(c, () => {
        if (!c.req.query("startdate") || !c.req.query("enddate"))
          throw new ApiError(400, "Additional fields are required: startdate, enddate.");
        const patient = c.req.query("patientid");
        return list(
          c,
          "appointments",
          data(store).appointments.filter(
            (a) => a.appointmentstatus === "f" && (!patient || a.patientid === patient) && inRange(a.date, c),
          ),
        );
      }),
    );
    app.put("/v1/:practiceid/appointments/:appointmentid", (c) =>
      run(c, async () => {
        const form = new URLSearchParams(await c.req.text());
        const appointment = data(store).appointments.find((a) => a.appointmentid === c.req.param("appointmentid"));
        if (!appointment) throw new ApiError(404, "The appointment ID is invalid.");
        if (appointment.appointmentstatus !== "o") throw new ApiError(409, "The appointment is not available.");
        const patientid = form.get("patientid");
        if (!patientid) throw new ApiError(400, "Additional fields are required: patientid.");
        patientFhirId(patientid);
        Object.assign(appointment, {
          appointmentstatus: "f",
          patientid,
          ...(form.get("appointmenttypeid") ? { appointmenttypeid: form.get("appointmenttypeid")! } : {}),
          scheduleddatetime: new Date().toISOString(),
        });
        return c.json([appointment]);
      }),
    );
    app.put("/v1/:practiceid/appointments/:appointmentid/cancel", (c) =>
      run(c, async () => {
        const form = new URLSearchParams(await c.req.text());
        const appointment = data(store).appointments.find((a) => a.appointmentid === c.req.param("appointmentid"));
        if (!appointment) throw new ApiError(404, "The appointment ID is invalid.");
        if (appointment.appointmentstatus !== "f")
          throw new ApiError(400, "Only booked appointments can be cancelled.");
        if (form.get("patientid") !== appointment.patientid)
          throw new ApiError(400, "The patientid does not match the appointment.");
        appointment.appointmentstatus = "x";
        appointment.cancelreason = form.get("cancellationreason") ?? "";
        return c.json({ status: "x" });
      }),
    );

    // FHIR R4 needs the practice on searches: ah-practice=Organization/a-1.Practice-<practiceid>.
    app.use(`${ATHENA_FHIR_PATH}/:type{[A-Z][A-Za-z]+}`, async (c, next) => {
      if (c.req.method !== "GET") return next();
      const practice = c.req.query("ah-practice") ?? "";
      const match = /^Organization\/a-1\.Practice-(\d+)$/.exec(practice);
      if (!match || !data(store).practiceIds.includes(match[1]))
        return c.body(
          JSON.stringify(
            operationOutcome(
              "required",
              "Search requires ah-practice=Organization/a-1.Practice-<practiceid> for a known practice",
            ),
          ),
          400,
          { "Content-Type": FHIR_JSON },
        );
      return next();
    });
    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: ATHENA_FHIR_PATH,
      software: { name: "emuhealth athenahealth emulator" },
      description:
        "Emulates the athenahealth APIs for local development with synthetic data. Not affiliated with athenahealth.",
    });

    app.on("GET", "/:rest{(?!_emulate).*}", (c) => c.json({ error: "The requested resource does not exist." }, 404));
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
    seedAppointments(store);
  },
};

export default athenaPlugin;
