import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateSyntheticRecords, type FhirResource, type GenerateOptions } from "@emuhealth/fhir-core";

/**
 * Availity emulator (emuhealth is not affiliated with Availity), following Availity's public HIPAA transaction API
 * guide: OAuth client credentials, the payer list, configurations, asynchronous Coverages (270/271) and Claim
 * Statuses (276/277) that are polled until statusCode 4, Service Reviews (278), and Demo plan mock scenarios
 * through X-Api-Mock-Scenario-ID. Payers, members, and claims are synthetic.
 */
export interface AvailitySeedConfig {
  port?: number;
  /** Members and claim history from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
  /** Polls that return "In Progress" before a coverage or claim status completes. Default 1. */
  pollsUntilComplete?: number;
}

const BASE = "/availity";
const DATA_KEY = "availity.data";
const SERVICE_LABEL = "Availity";
const TOKEN_TTL_S = 300;

export const PAYERS = [
  { payerId: "SYNAV1", payerName: "Synthetic Commercial Health", processingRoutes: ["270", "276", "278"] },
  { payerId: "SYNAV2", payerName: "Synthetic Medicaid Plan", processingRoutes: ["270", "276"] },
];

interface Member {
  memberId: string;
  payerId: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string;
}
interface SyntheticClaim {
  claimNumber: string;
  memberId: string;
  fromDate: string;
  toDate: string;
  chargeAmount: number;
  paidAmount: number;
}
interface Job {
  id: string;
  kind: "coverage" | "claim-status" | "service-review";
  polls: number;
  created: string;
  request: Record<string, string>;
  result: Record<string, unknown>;
}
interface Data {
  tokens: Map<string, number>;
  members: Member[];
  claims: SyntheticClaim[];
  jobs: Map<string, Job>;
  pollsUntilComplete: number;
}

function build(options: GenerateOptions = {}): Pick<Data, "members" | "claims"> {
  const records = generateSyntheticRecords(options);
  const members = records
    .filter((r) => r.resourceType === "Patient")
    .map((p: FhirResource, i): Member => {
      const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
      return {
        memberId: `AVM${String(i + 1).padStart(7, "0")}`,
        payerId: PAYERS[i % PAYERS.length].payerId,
        firstName: String(name.given?.[0] ?? "").toUpperCase(),
        lastName: String(name.family ?? "").toUpperCase(),
        birthDate: String(p.birthDate ?? ""),
        gender: p.gender === "female" ? "F" : "M",
      };
    });
  const patientIds = records.filter((r) => r.resourceType === "Patient").map((p) => p.id!);
  const claims = records
    .filter((r) => r.resourceType === "Encounter")
    .map((e, i): SyntheticClaim => {
      const patient = String((e.subject as { reference?: string }).reference).split("/")[1];
      const member = members[patientIds.indexOf(patient)];
      const day = String((e.period as { start: string }).start).slice(0, 10);
      const charge = 120 + (i % 5) * 35;
      return {
        claimNumber: `AVC${String(i + 1).padStart(8, "0")}`,
        memberId: member.memberId,
        fromDate: day,
        toDate: day,
        chargeAmount: charge,
        paidAmount: Number((charge * 0.75).toFixed(2)),
      };
    });
  return { members, claims };
}

function data(store: Store): Data {
  let d = store.getData<Data>(DATA_KEY);
  if (!d) {
    d = { tokens: new Map(), jobs: new Map(), pollsUntilComplete: 1, ...build() };
    store.setData(DATA_KEY, d);
  }
  return d;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: AvailitySeedConfig): void {
  const d = data(store);
  if (config.generate !== undefined) Object.assign(d, build(config.generate));
  if (config.pollsUntilComplete !== undefined) {
    if (!Number.isInteger(config.pollsUntilComplete) || config.pollsUntilComplete < 0 || config.pollsUntilComplete > 10)
      throw new Error("availity.pollsUntilComplete must be an integer from 0 to 10");
    d.pollsUntilComplete = config.pollsUntilComplete;
  }
}

type AnyContext = Context<AppEnv>;

class AvailityError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors: Array<{ field?: string; errorMessage: string }> = [],
  ) {
    super(message);
  }
}

const IN_PROGRESS = { statusCode: "0", status: "In Progress" };
const COMPLETE = { statusCode: "4", status: "Complete" };

/** Demo plan scenarios: the response Availity's mock returns for X-Api-Mock-Scenario-ID. */
function mockScenario(c: AnyContext, scenario: string): Response | undefined {
  const id = randomUUID();
  const headers = { "X-Api-Mock-Response": "true", "X-Api-Mock-Scenario-ID": scenario };
  const json = (status: number, body: unknown) => c.json(body, status as never, headers);
  switch (scenario) {
    case "Coverages-Complete-i":
      return json(200, {
        id,
        ...COMPLETE,
        payer: { id: PAYERS[0].payerId, name: PAYERS[0].payerName },
        plans: [{ ...COMPLETE, planName: "SYNTHETIC PPO", coverageStartDate: "2025-01-01" }],
      });
    case "Coverages-InProgress-i":
      return json(202, { id, ...IN_PROGRESS, etaDate: new Date(Date.now() + 5000).toISOString() });
    case "Coverages-Retrying-i":
      return json(202, { id, statusCode: "R1", status: "Communication Error, Retrying" });
    case "Coverages-RequestError1-i":
      return json(400, {
        userMessage: "The request is invalid.",
        errors: [{ field: "memberId", errorMessage: "Member ID is required." }],
      });
    case "SR-CreateRequestAccepted-i":
      return c.json({ id }, 202, { ...headers, Location: `${BASE}/v2/service-reviews/${id}` });
    case "SR-GetComplete-i":
      return json(200, { id, status: "Approved", statusCode: "A1", certificationNumber: "SYNCERT0001" });
    case "SR-GetPayerDown-i":
      return json(504, { userMessage: "The payer is unavailable. Try again later." });
    case "SR-GetRetrying-i":
      return json(202, { id, statusCode: "R1", status: "Communication Error, Retrying" });
    default:
      return undefined;
  }
}

export const availityPlugin: ServicePlugin = {
  name: "availity",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const d = () => data(store);

    app.post(`${BASE}/v1/token`, async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
      const [id, secret] = basic
        ? Buffer.from(basic[1], "base64").toString("utf8").split(":")
        : [form.get("client_id"), form.get("client_secret")];
      if (!id || !secret)
        return c.json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
      if (form.get("grant_type") !== "client_credentials") return c.json({ error: "unsupported_grant_type" }, 400);
      const token = randomBytes(24).toString("base64url");
      d().tokens.set(token, Date.now() + TOKEN_TTL_S * 1000);
      return c.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_S,
        scope: form.get("scope") ?? "hipaa",
      });
    });

    app.use(`${BASE}/:rest{.*}`, async (c, next) => {
      if (c.req.path === `${BASE}/v1/token`) return next();
      const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const expires = token ? d().tokens.get(token) : undefined;
      if (!expires || expires < Date.now())
        return c.json({ userMessage: "Unauthorized: a valid Bearer token is required." }, 401);
      const scenario = c.req.header("X-Api-Mock-Scenario-ID");
      if (scenario) {
        const mocked = mockScenario(c, scenario);
        if (!mocked) return c.json({ userMessage: `Unknown mock scenario ${scenario}` }, 400);
        return mocked;
      }
      return next();
    });

    const run = async (c: AnyContext, handler: () => Response | Promise<Response>) => {
      try {
        return await handler();
      } catch (err) {
        if (err instanceof AvailityError)
          return c.json(
            { userMessage: err.message, ...(err.errors.length ? { errors: err.errors } : {}) },
            err.status as never,
          );
        throw err;
      }
    };
    const payer = (id: string | undefined) => {
      const p = PAYERS.find((x) => x.payerId === id);
      if (!p)
        throw new AvailityError(400, "The payer is not valid.", [
          { field: "payerId", errorMessage: `Unknown payer ${id ?? ""}` },
        ]);
      return p;
    };
    const member = (payerId: string, q: (name: string) => string | undefined) =>
      d().members.find(
        (m) =>
          m.payerId === payerId &&
          (q("memberId")
            ? m.memberId === q("memberId")
            : m.lastName === String(q("patientLastName") ?? "").toUpperCase() && m.birthDate === q("patientBirthDate")),
      );
    const readForm = async (c: AnyContext) => {
      const type = c.req.header("Content-Type") ?? "";
      if (type.includes("json"))
        return Object.fromEntries(
          Object.entries((await c.req.json().catch(() => ({}))) as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ]),
        );
      return Object.fromEntries(new URLSearchParams(await c.req.text()));
    };
    /** Each GET of a job counts as a poll; it completes after pollsUntilComplete polls. */
    const poll = (job: Job) => {
      job.polls++;
      const done = job.polls > d().pollsUntilComplete;
      return done
        ? { id: job.id, ...COMPLETE, createdDate: job.created, updatedDate: new Date().toISOString(), ...job.result }
        : { id: job.id, ...IN_PROGRESS, createdDate: job.created, etaDate: new Date(Date.now() + 2000).toISOString() };
    };

    const payerList = (c: AnyContext) => {
      const route = c.req.query("transactionType");
      return c.json({
        totalCount: PAYERS.length,
        payers: PAYERS.filter(
          (p) =>
            (!c.req.query("payerId") || p.payerId === c.req.query("payerId")) &&
            (!route || p.processingRoutes.includes(route)),
        ).map((p) => ({
          payerId: p.payerId,
          payerName: p.payerName,
          processingRoutes: p.processingRoutes.map((t) => ({
            transactionType: t,
            submissionMode: "API",
            availability: "available",
            enrollmentRequired: false,
          })),
        })),
      });
    };
    app.get(`${BASE}/availity-payer-list`, payerList);
    app.get(`${BASE}/v1/availity-payer-list`, payerList);

    app.get(`${BASE}/v1/configurations`, (c) =>
      run(c, () => {
        const type = c.req.query("type");
        if (!type)
          throw new AvailityError(400, "type is required.", [{ field: "type", errorMessage: "type is required" }]);
        const fields: Record<string, string[]> = {
          "270": [
            "payerId",
            "providerNpi",
            "memberId",
            "patientBirthDate",
            "patientLastName",
            "serviceType",
            "asOfDate",
          ],
          "claim-statuses-inquiry": ["payerId", "providerNpi", "memberId", "patientBirthDate", "fromDate", "toDate"],
          "service-reviews": [
            "payerId",
            "requestTypeCode",
            "serviceTypeCode",
            "fromDate",
            "toDate",
            "diagnoses",
            "procedures",
          ],
        };
        return c.json({
          configurations: PAYERS.filter((p) => !c.req.query("payerId") || p.payerId === c.req.query("payerId")).map(
            (p) => ({
              type,
              payerId: p.payerId,
              elements: Object.fromEntries(
                (fields[type] ?? []).map((f) => [f, { required: ["payerId", "providerNpi"].includes(f) }]),
              ),
            }),
          ),
        });
      }),
    );

    // Coverages (270/271): POST starts an inquiry, GET polls it.
    app.post(`${BASE}/v1/coverages`, (c) =>
      run(c, async () => {
        const f = await readForm(c);
        const p = payer(f.payerId);
        const missing = ["providerNpi", "memberId"].filter(
          (k) => !f[k] && !(k === "memberId" && f.patientLastName && f.patientBirthDate),
        );
        if (missing.length)
          throw new AvailityError(
            400,
            "The request is invalid.",
            missing.map((field) => ({ field, errorMessage: `${field} is required.` })),
          );
        const m = member(p.payerId, (k) => f[k]);
        const serviceType = f.serviceType ?? "30";
        const result = m
          ? {
              payer: { id: p.payerId, name: p.payerName },
              requestingProvider: { npi: f.providerNpi },
              subscriber: {
                memberId: m.memberId,
                firstName: m.firstName,
                lastName: m.lastName,
                birthDate: m.birthDate,
                gender: m.gender,
              },
              patient: {
                firstName: m.firstName,
                lastName: m.lastName,
                birthDate: m.birthDate,
                subscriberRelationship: "Self",
              },
              requestedServiceType: [
                {
                  code: serviceType,
                  value: serviceType === "30" ? "Health Benefit Plan Coverage" : `Service type ${serviceType}`,
                },
              ],
              asOfDate: f.asOfDate ?? new Date().toISOString().slice(0, 10),
              plans: [
                {
                  status: "Active Coverage",
                  statusCode: "1",
                  groupNumber: "SYNGRP",
                  groupName: "SYNTHETIC EMPLOYER GROUP",
                  insuranceType: "Commercial",
                  planName: `${p.payerName} PPO`,
                  coverageStartDate: "2025-01-01",
                  benefits: [
                    {
                      name: "Deductible",
                      type: serviceType,
                      amounts: {
                        inNetwork: {
                          deductibles: [
                            {
                              amount: "1500.00",
                              remaining: "850.00",
                              level: "Individual",
                              timePeriod: "Calendar Year",
                            },
                          ],
                        },
                      },
                    },
                    {
                      name: "Co-Payment",
                      type: serviceType,
                      amounts: { inNetwork: { coPayment: [{ amount: "25.00", level: "Individual" }] } },
                    },
                    {
                      name: "Co-Insurance",
                      type: serviceType,
                      amounts: { inNetwork: { coInsurance: [{ amount: "20", level: "Individual" }] } },
                    },
                    {
                      name: "Out of Pocket",
                      type: serviceType,
                      amounts: {
                        inNetwork: { outOfPocket: [{ amount: "5000.00", remaining: "4100.00", level: "Individual" }] },
                      },
                    },
                  ],
                },
              ],
            }
          : {
              statusCode: "6",
              status: "Rejection Error",
              validationMessages: [{ code: "75", errorMessage: "Subscriber/Insured Not Found" }],
            };
        const job: Job = {
          id: randomUUID(),
          kind: "coverage",
          polls: 0,
          created: new Date().toISOString(),
          request: f,
          result,
        };
        d().jobs.set(job.id, job);
        return c.json({ id: job.id, ...IN_PROGRESS, createdDate: job.created }, 202, {
          Location: `${BASE}/v1/coverages/${job.id}`,
        });
      }),
    );
    app.get(`${BASE}/v1/coverages/:id`, (c) =>
      run(c, () => {
        const job = d().jobs.get(c.req.param("id"));
        if (!job || job.kind !== "coverage") throw new AvailityError(404, "The coverage was not found.");
        const body = poll(job);
        return c.json(body, body.statusCode === "0" ? 202 : 200);
      }),
    );
    app.get(`${BASE}/v1/coverages`, (c) =>
      c.json({
        coverages: [...d().jobs.values()]
          .filter(
            (j) =>
              j.kind === "coverage" && (!c.req.query("memberId") || j.request.memberId === c.req.query("memberId")),
          )
          .map((j) => ({
            id: j.id,
            ...(j.polls > d().pollsUntilComplete ? COMPLETE : IN_PROGRESS),
            createdDate: j.created,
          })),
      }),
    );
    app.delete(`${BASE}/v1/coverages/:id`, (c) => {
      d().jobs.delete(c.req.param("id"));
      return c.body(null, 204);
    });

    // Claim Statuses (276/277): GET with criteria starts an inquiry, GET by id polls it.
    app.get(`${BASE}/v1/claim-statuses`, (c) =>
      run(c, () => {
        const q = (k: string) => c.req.query(k);
        const p = payer(q("payerId"));
        if (!q("providerNpi"))
          throw new AvailityError(400, "The request is invalid.", [
            { field: "providerNpi", errorMessage: "providerNpi is required." },
          ]);
        const m = member(p.payerId, q);
        const from = q("fromDate") ?? "0000-00-00";
        const to = q("toDate") ?? "9999-99-99";
        const claims = d().claims.filter(
          (cl) => m && cl.memberId === m.memberId && cl.fromDate >= from && cl.toDate <= to,
        );
        const result = {
          payer: { id: p.payerId, name: p.payerName },
          claimStatuses: claims.length
            ? claims.map((cl) => ({
                claimNumber: cl.claimNumber,
                fromDate: cl.fromDate,
                toDate: cl.toDate,
                totalClaimChargeAmount: cl.chargeAmount.toFixed(2),
                claimPaymentAmount: cl.paidAmount.toFixed(2),
                statusDetails: [
                  {
                    categoryCode: "F1",
                    category: "Finalized/Payment",
                    statusCode: "65",
                    status: "Claim/line has been paid.",
                    effectiveDate: cl.toDate,
                  },
                ],
              }))
            : [
                {
                  statusDetails: [
                    {
                      categoryCode: "A4",
                      category: "Acknowledgement/Not Found",
                      statusCode: "35",
                      status: "Claim/encounter not found.",
                    },
                  ],
                },
              ],
        };
        const job: Job = {
          id: randomUUID(),
          kind: "claim-status",
          polls: 0,
          created: new Date().toISOString(),
          request: Object.fromEntries(new URL(c.req.url).searchParams),
          result,
        };
        d().jobs.set(job.id, job);
        return c.json({ claimStatuses: [{ id: job.id, ...IN_PROGRESS, createdDate: job.created }] }, 202);
      }),
    );
    app.get(`${BASE}/v1/claim-statuses/:id`, (c) =>
      run(c, () => {
        const job = d().jobs.get(c.req.param("id"));
        if (!job || job.kind !== "claim-status") throw new AvailityError(404, "The claim status was not found.");
        const body = poll(job);
        return c.json(body, body.statusCode === "0" ? 202 : 200);
      }),
    );

    // Service Reviews (278): asynchronous; POST returns a Location to query.
    app.post(`${BASE}/v2/service-reviews`, (c) =>
      run(c, async () => {
        const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
        if (!body) throw new AvailityError(400, "The request body must be JSON.");
        const p = payer(
          body.payer && typeof body.payer === "object"
            ? String((body.payer as Record<string, unknown>).id ?? "")
            : String(body.payerId ?? ""),
        );
        if (!p.processingRoutes.includes("278"))
          throw new AvailityError(400, `${p.payerName} does not accept service reviews.`);
        const job: Job = {
          id: randomUUID(),
          kind: "service-review",
          polls: 0,
          created: new Date().toISOString(),
          request: {},
          result: {
            ...body,
            payer: { id: p.payerId, name: p.payerName },
            status: "Approved",
            statusCode: "A1",
            certificationNumber: `SYNCERT${randomBytes(3).toString("hex").toUpperCase()}`,
            updatable: true,
            deletable: true,
          },
        };
        d().jobs.set(job.id, job);
        return c.json({ id: job.id }, 202, { Location: `${BASE}/v2/service-reviews/${job.id}` });
      }),
    );
    app.get(`${BASE}/v2/service-reviews/:id`, (c) =>
      run(c, () => {
        const job = d().jobs.get(c.req.param("id"));
        if (!job || job.kind !== "service-review") throw new AvailityError(404, "The service review was not found.");
        const body = poll(job);
        return c.json(body, body.statusCode === "0" ? 202 : 200);
      }),
    );
    app.get(`${BASE}/v2/service-reviews`, (c) =>
      c.json({
        serviceReviews: [...d().jobs.values()]
          .filter((j) => j.kind === "service-review")
          .map((j) => ({ id: j.id, ...j.result })),
      }),
    );
    app.delete(`${BASE}/v2/service-reviews/:id`, (c) =>
      run(c, () => {
        const job = d().jobs.get(c.req.param("id"));
        if (!job || job.kind !== "service-review") throw new AvailityError(404, "The service review was not found.");
        job.result = { ...job.result, status: "Voided", statusCode: "VOID", updatable: false, deletable: false };
        return c.json({ id: job.id }, 202, { Location: `${BASE}/v2/service-reviews/${job.id}` });
      }),
    );

    app.get("/_inspector", (c) => {
      const rows = d().members.map(
        (m) =>
          `<tr><td>${escapeHtml(m.memberId)}</td><td>${escapeHtml(m.payerId)}</td><td>${escapeHtml(`${m.firstName} ${m.lastName}`)}</td><td>${escapeHtml(m.birthDate)}</td><td>${d().claims.filter((cl) => cl.memberId === m.memberId).length}</td></tr>`,
      );
      const body = `<div class="inspector-section"><h2>Members</h2><p>Payers: ${PAYERS.map((p) => `${escapeHtml(p.payerName)} (${p.payerId})`).join(", ")}. Inquiries complete after ${d().pollsUntilComplete} poll(s).</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>member id</th><th>payer</th><th>name</th><th>birth date</th><th>claims</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Availity inspector",
          [{ id: "members", label: "Members", href: "/_inspector" }],
          "members",
          body,
          SERVICE_LABEL,
        ),
      );
    });
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, { tokens: new Map(), jobs: new Map(), pollsUntilComplete: 1, ...build() });
  },
};

export default availityPlugin;
