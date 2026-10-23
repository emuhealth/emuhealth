import { randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateSyntheticRecords, type FhirResource, type GenerateOptions } from "@emuhealth/fhir-core";

/**
 * Stedi healthcare clearinghouse emulator (emuhealth is not affiliated with Stedi): real-time eligibility (270/271),
 * professional claims (837P), real-time claim status (276/277), and 835 ERAs, in Stedi's JSON forms, against
 * synthetic payers and members. Claims are adjudicated at once, so status and remittance are ready to fetch.
 */
export interface StediSeedConfig {
  port?: number;
  /** API keys accepted in the Authorization header. Default: any non-empty key. */
  apiKeys?: string[];
  /** Members, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
  /** Event destinations that receive transaction.processed.v2 events for 835 ERAs. */
  webhooks?: Array<{ url: string }>;
}

const V = "/2024-04-01/change/medicalnetwork";
const DATA_KEY = "stedi.data";
const OWNER = "stedi";
const SERVICE_LABEL = "Stedi";

export const PAYERS = [
  { stediId: "SYNHP", displayName: "Synthetic Health Plan", primaryPayerId: "SYN01", aliases: ["SYN01"], allowed: 0.8 },
  {
    stediId: "SYNCARE",
    displayName: "Synthetic Senior Care",
    primaryPayerId: "SYN02",
    aliases: ["SYN02"],
    allowed: 0.7,
  },
];

interface Member {
  memberId: string;
  payerId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  address: Record<string, string>;
  groupNumber: string;
}

interface Claim {
  id: string;
  payerId: string;
  memberId: string;
  patientControlNumber: string;
  chargeAmount: number;
  paidAmount: number;
  serviceDate: string;
  serviceLines: Array<{ procedureCode: string; charge: number; paid: number }>;
  transactionId: string;
  payerClaimControlNumber: string;
  submittedAt: string;
  providerNpi: string;
  providerName: string;
}

interface Data {
  apiKeys: string[];
  members: Member[];
  claims: Claim[];
}

const ymd = (iso: string) => iso.replace(/-/g, "").slice(0, 8);

export function membersFrom(options: GenerateOptions = {}): Member[] {
  return generateSyntheticRecords(options)
    .filter((r) => r.resourceType === "Patient")
    .map((p: FhirResource, i) => {
      const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
      const address = (p.address as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
      return {
        memberId: `SYNM${String(i + 1).padStart(6, "0")}`,
        payerId: PAYERS[i % PAYERS.length].primaryPayerId,
        firstName: String(name.given?.[0] ?? "").toUpperCase(),
        lastName: String(name.family ?? "").toUpperCase(),
        dateOfBirth: ymd(String(p.birthDate ?? "")),
        gender: p.gender === "female" ? "F" : "M",
        address: {
          address1: ((address.line as string[] | undefined) ?? [])[0] ?? "",
          city: String(address.city ?? ""),
          state: String(address.state ?? ""),
          postalCode: String(address.postalCode ?? ""),
        },
        groupNumber: "SYNGRP001",
      };
    });
}

type AnyContext = Context<AppEnv>;
const dispatchers = new WeakMap<Store, WebhookDispatcher>();

function data(store: Store): Data {
  let d = store.getData<Data>(DATA_KEY);
  if (!d) {
    d = { apiKeys: [], members: membersFrom(), claims: [] };
    store.setData(DATA_KEY, d);
  }
  return d;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: StediSeedConfig): void {
  const d = data(store);
  if (config.apiKeys !== undefined) {
    if (!Array.isArray(config.apiKeys) || config.apiKeys.some((k) => typeof k !== "string" || !k))
      throw new Error("stedi.apiKeys must be an array of non-empty strings");
    d.apiKeys = config.apiKeys;
  }
  if (config.generate !== undefined) d.members = membersFrom(config.generate);
  if (config.webhooks !== undefined) {
    if (
      !Array.isArray(config.webhooks) ||
      config.webhooks.some((w) => typeof w?.url !== "string" || !/^https?:\/\//.test(w.url))
    )
      throw new Error("stedi.webhooks must be an array of { url } with http(s) URLs");
    const webhooks = dispatchers.get(store);
    for (const sub of webhooks?.getSubscriptions(OWNER) ?? []) webhooks?.unregister(sub.id);
    for (const w of config.webhooks) webhooks?.register({ url: w.url, events: ["*"], active: true, owner: OWNER });
  }
}

const SERVICE_TYPES: Record<string, string> = {
  "1": "Medical Care",
  "30": "Health Benefit Plan Coverage",
  "33": "Chiropractic",
  "35": "Dental Care",
  "47": "Hospital",
  "48": "Hospital - Inpatient",
  "50": "Hospital - Outpatient",
  "86": "Emergency Services",
  "88": "Pharmacy",
  "98": "Professional (Physician) Visit - Office",
  UC: "Urgent Care",
};

class StediError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const money = (n: number) => n.toFixed(2);

export const stediPlugin: ServicePlugin = {
  name: "stedi",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, _baseUrl: string, _tokenMap?: TokenMap): void {
    dispatchers.set(store, webhooks);
    const d = () => data(store);

    // Stedi takes the API key as the Authorization header, with or without a "Key " prefix.
    app.use("/:version{20\\d\\d-\\d\\d-\\d\\d}/:rest{.*}", async (c, next) => {
      const key = (c.req.header("Authorization") ?? "").replace(/^Key\s+/i, "").trim();
      const keys = d().apiKeys;
      if (!key || (keys.length > 0 && !keys.includes(key)))
        return c.json({ message: "Unauthorized. Send your Stedi API key in the Authorization header." }, 401);
      return next();
    });

    const run = async (c: AnyContext, handler: () => Response | Promise<Response>) => {
      try {
        return await handler();
      } catch (err) {
        if (err instanceof StediError)
          return c.json({ message: err.message, code: "BAD_REQUEST" }, err.status as never);
        throw err;
      }
    };
    const body = async (c: AnyContext): Promise<Record<string, any>> => {
      const parsed = await c.req.json().catch(() => undefined);
      if (!parsed || typeof parsed !== "object") throw new StediError(400, "The request body must be a JSON object");
      return parsed as Record<string, any>;
    };
    const payerFor = (id: unknown) => {
      const payer = PAYERS.find((p) => p.primaryPayerId === id || p.stediId === id || p.aliases.includes(String(id)));
      if (!payer)
        throw new StediError(
          400,
          `Unknown tradingPartnerServiceId ${String(id)}. Use one of ${PAYERS.map((p) => p.primaryPayerId).join(", ")}.`,
        );
      return payer;
    };
    const findMember = (payerId: string, subscriber: Record<string, string> | undefined) =>
      d().members.find(
        (m) =>
          m.payerId === payerId &&
          (subscriber?.memberId
            ? m.memberId === subscriber.memberId
            : m.lastName === String(subscriber?.lastName ?? "").toUpperCase() &&
              m.dateOfBirth === subscriber?.dateOfBirth),
      );
    const meta = () => ({
      senderId: "emuhealth",
      submitterId: "emuhealth",
      applicationMode: "test",
      traceId: randomUUID(),
      outboundTraceId: randomUUID(),
    });

    app.get("/2024-04-01/payers", (c) =>
      c.json({
        items: PAYERS.map(({ allowed: _allowed, ...p }) => ({
          ...p,
          transactionSupport: {
            eligibilityCheck: "SUPPORTED",
            claimStatus: "SUPPORTED",
            professionalClaimSubmission: "SUPPORTED",
            claimPayment: "SUPPORTED",
          },
        })),
      }),
    );

    // Eligibility (270 request, 271 response).
    app.post(`${V}/eligibility/v3`, (c) =>
      run(c, async () => {
        const req = await body(c);
        const payer = payerFor(req.tradingPartnerServiceId);
        if (!req.provider?.npi) throw new StediError(400, "provider.npi is required");
        const member = findMember(payer.primaryPayerId, req.subscriber);
        const serviceTypeCodes: string[] = req.encounter?.serviceTypeCodes ?? ["30"];
        const common = {
          meta: meta(),
          controlNumber: req.controlNumber ?? String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
          reassociationKey: req.controlNumber ?? "",
          tradingPartnerServiceId: payer.primaryPayerId,
          provider: {
            providerName: req.provider.organizationName ?? "",
            entityIdentifier: "Provider",
            entityType: "Non-Person Entity",
            npi: req.provider.npi,
          },
          payer: {
            entityIdentifier: "Payer",
            entityType: "Non-Person Entity",
            name: payer.displayName,
            payorIdentification: payer.primaryPayerId,
          },
        };
        if (!member)
          return c.json({
            ...common,
            subscriber: req.subscriber ?? {},
            errors: [
              {
                field: "AAA",
                code: "75",
                description: "Subscriber/Insured Not Found",
                followupAction: "Please Correct and Resubmit",
                location: "Loop 2100C",
              },
            ],
          });
        const benefits = serviceTypeCodes.flatMap((code) => {
          const serviceTypes = [SERVICE_TYPES[code] ?? "Health Benefit Plan Coverage"];
          return [
            {
              code: "1",
              name: "Active Coverage",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              insuranceTypeCode: "C1",
              insuranceType: "Commercial",
              planCoverage: `${payer.displayName} PPO`,
            },
            {
              code: "C",
              name: "Deductible",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              timeQualifierCode: "23",
              timeQualifier: "Calendar Year",
              benefitAmount: "1500",
              inPlanNetworkIndicatorCode: "Y",
              inPlanNetworkIndicator: "Yes",
            },
            {
              code: "C",
              name: "Deductible",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              timeQualifierCode: "29",
              timeQualifier: "Remaining",
              benefitAmount: "850",
              inPlanNetworkIndicatorCode: "Y",
              inPlanNetworkIndicator: "Yes",
            },
            {
              code: "B",
              name: "Co-Payment",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              timeQualifierCode: "27",
              timeQualifier: "Visit",
              benefitAmount: "25",
              inPlanNetworkIndicatorCode: "Y",
              inPlanNetworkIndicator: "Yes",
            },
            {
              code: "A",
              name: "Co-Insurance",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              timeQualifierCode: "27",
              timeQualifier: "Visit",
              benefitPercent: String(Number((1 - payer.allowed).toFixed(2))),
              inPlanNetworkIndicatorCode: "Y",
              inPlanNetworkIndicator: "Yes",
            },
            {
              code: "G",
              name: "Out of Pocket (Stop Loss)",
              coverageLevelCode: "IND",
              coverageLevel: "Individual",
              serviceTypeCodes: [code],
              serviceTypes,
              timeQualifierCode: "23",
              timeQualifier: "Calendar Year",
              benefitAmount: "5000",
              inPlanNetworkIndicatorCode: "Y",
              inPlanNetworkIndicator: "Yes",
            },
          ];
        });
        return c.json({
          ...common,
          subscriber: {
            memberId: member.memberId,
            firstName: member.firstName,
            lastName: member.lastName,
            gender: member.gender,
            entityIdentifier: "Insured or Subscriber",
            entityType: "Person",
            dateOfBirth: member.dateOfBirth,
            groupNumber: member.groupNumber,
            address: member.address,
          },
          planInformation: { groupNumber: member.groupNumber, groupDescription: "SYNTHETIC GROUP" },
          planDateInformation: { planBegin: "20250101", planEnd: "20251231", eligibilityBegin: "20200101" },
          planStatus: [
            { statusCode: "1", status: "Active Coverage", planDetails: `${payer.displayName} PPO`, serviceTypeCodes },
          ],
          benefitsInformation: benefits,
          errors: [],
        });
      }),
    );

    // Professional claims (837P). The emulator adjudicates at once: allowed share of charges paid, 835 ready.
    app.post(`${V}/professionalclaims/v3/submission`, (c) =>
      run(c, async () => {
        const req = await body(c);
        const payer = payerFor(req.tradingPartnerServiceId);
        const info = req.claimInformation;
        const missing = [
          !req.submitter && "submitter",
          !req.receiver && "receiver",
          !req.subscriber?.memberId && "subscriber.memberId",
          !req.billing?.npi && "billing.npi",
          !info && "claimInformation",
          info && !info.patientControlNumber && "claimInformation.patientControlNumber",
          info && !info.claimChargeAmount && "claimInformation.claimChargeAmount",
          info && !Array.isArray(info.serviceLines) && "claimInformation.serviceLines",
          info && !Array.isArray(info.healthCareCodeInformation) && "claimInformation.healthCareCodeInformation",
        ].filter(Boolean);
        if (missing.length) throw new StediError(400, `Missing required fields: ${missing.join(", ")}`);
        const member = findMember(payer.primaryPayerId, { memberId: req.subscriber.memberId });
        const lines = (info.serviceLines as Array<Record<string, any>>).map((l) => {
          const charge = Number(l.professionalService?.lineItemChargeAmount ?? 0);
          return {
            procedureCode: String(l.professionalService?.procedureCode ?? ""),
            charge,
            paid: member ? Number((charge * payer.allowed).toFixed(2)) : 0,
          };
        });
        const total = Number(info.claimChargeAmount);
        const lineTotal = lines.reduce((s, l) => s + l.charge, 0);
        if (Math.abs(lineTotal - total) > 0.005)
          throw new StediError(
            400,
            `claimChargeAmount ${money(total)} does not equal the sum of service line charges ${money(lineTotal)}`,
          );
        const claim: Claim = {
          id: randomUUID(),
          payerId: payer.primaryPayerId,
          memberId: req.subscriber.memberId,
          patientControlNumber: info.patientControlNumber,
          chargeAmount: total,
          paidAmount: lines.reduce((s, l) => s + l.paid, 0),
          serviceDate: String(info.serviceLines[0]?.serviceDate ?? ymd(new Date().toISOString())),
          serviceLines: lines,
          transactionId: randomUUID(),
          payerClaimControlNumber: `SYN${Date.now()}${Math.floor(Math.random() * 1000)}`,
          submittedAt: new Date().toISOString(),
          providerNpi: req.billing.npi,
          providerName: req.billing.organizationName ?? "",
        };
        d().claims.push(claim);
        void webhooks.dispatch(
          "transaction.processed.v2",
          undefined,
          {
            event: {
              "detail-type": "transaction.processed.v2",
              detail: {
                transactionId: claim.transactionId,
                direction: "INBOUND",
                mode: "test",
                x12: { transactionSetIdentifier: "835" },
                businessIdentifier: claim.patientControlNumber,
              },
            },
          },
          OWNER,
        );
        return c.json({
          status: "SUCCESS",
          controlNumber: req.controlNumber ?? "",
          tradingPartnerServiceId: payer.primaryPayerId,
          claimReference: {
            correlationId: claim.id,
            submitterId: "emuhealth",
            customerClaimNumber: info.patientControlNumber,
            patientControlNumber: info.patientControlNumber,
            timeOfResponse: claim.submittedAt,
            claimType: "PRO",
            formatVersion: "5010",
            rhClaimNumber: claim.payerClaimControlNumber,
          },
          httpStatusCode: "200 OK",
          meta: meta(),
          payer: { payerName: payer.displayName, payerID: payer.primaryPayerId },
        });
      }),
    );

    // Claim status (276 request, 277 response).
    app.post(`${V}/claimstatus/v2`, (c) =>
      run(c, async () => {
        const req = await body(c);
        const payer = payerFor(req.tradingPartnerServiceId);
        if (!req.subscriber?.memberId && !req.subscriber?.lastName)
          throw new StediError(400, "subscriber.memberId or subscriber.lastName is required");
        const member = findMember(payer.primaryPayerId, req.subscriber);
        const from = req.encounter?.beginningDateOfService ?? "00000000";
        const to = req.encounter?.endDateOfService ?? "99999999";
        const claims = d().claims.filter(
          (cl) =>
            cl.payerId === payer.primaryPayerId &&
            (member ? cl.memberId === member.memberId : cl.memberId === req.subscriber.memberId) &&
            cl.serviceDate >= from &&
            cl.serviceDate <= to &&
            (!req.encounter?.trackingNumber || cl.patientControlNumber === req.encounter.trackingNumber),
        );
        const status = (cl: Claim) =>
          cl.paidAmount > 0
            ? {
                statusCategoryCode: "F1",
                statusCategoryCodeValue: "Finalized/Payment-The claim/line has been paid.",
                statusCode: "65",
                statusCodeValue: "Claim/line has been paid.",
              }
            : {
                statusCategoryCode: "F2",
                statusCategoryCodeValue: "Finalized/Denial-The claim/line has been denied.",
                statusCode: "88",
                statusCodeValue: "Entity not eligible for benefits.",
              };
        return c.json({
          id: `csc_${randomUUID()}`,
          controlNumber: req.controlNumber ?? "",
          tradingPartnerServiceId: payer.primaryPayerId,
          payer: { name: payer.displayName, payerIdentification: payer.primaryPayerId },
          meta: meta(),
          claims: claims.length
            ? claims.map((cl) => ({
                claimStatus: {
                  ...status(cl),
                  entityCode: "PR",
                  entity: "Payer",
                  effectiveDate: ymd(cl.submittedAt),
                  claimServiceDate: cl.serviceDate,
                  submittedAmount: money(cl.chargeAmount),
                  amountPaid: money(cl.paidAmount),
                  paidDate: ymd(cl.submittedAt),
                  checkIssueDate: ymd(cl.submittedAt),
                  checkNumber: `EFT${cl.payerClaimControlNumber.slice(-8)}`,
                  trackingNumber: cl.patientControlNumber,
                  patientAccountNumber: cl.patientControlNumber,
                  tradingPartnerClaimNumber: cl.payerClaimControlNumber,
                },
                serviceDetails: cl.serviceLines.map((l) => ({
                  service: {
                    serviceIdQualifierCode: "HC",
                    procedureId: l.procedureCode,
                    chargeAmount: money(l.charge),
                    amountPaid: money(l.paid),
                  },
                  status: [status(cl)],
                })),
              }))
            : [
                {
                  claimStatus: {
                    statusCategoryCode: "A4",
                    statusCategoryCodeValue:
                      "Acknowledgement/Not Found-The claim/encounter cannot be found in the adjudication system.",
                    statusCode: "35",
                    statusCodeValue: "Claim/encounter not found.",
                    entityCode: "PR",
                    entity: "Payer",
                  },
                },
              ],
        });
      }),
    );

    // 835 ERA for an adjudicated claim, by transaction id.
    app.get(`${V}/reports/v2/:transactionId/835`, (c) =>
      run(c, () => {
        const cl = d().claims.find((x) => x.transactionId === c.req.param("transactionId"));
        if (!cl) throw new StediError(404, `Transaction ${c.req.param("transactionId")} not found`);
        const payer = PAYERS.find((p) => p.primaryPayerId === cl.payerId)!;
        const member = d().members.find((m) => m.memberId === cl.memberId);
        return c.json({
          meta: meta(),
          transactions: [
            {
              controlNumber: "0001",
              financialInformation: {
                transactionHandlingCode: "I",
                totalActualProviderPaymentAmount: money(cl.paidAmount),
                creditOrDebitFlagCode: "C",
                paymentMethodCode: "ACH",
                checkIssueOrEFTEffectiveDate: ymd(cl.submittedAt),
              },
              paymentAndRemitReassociationDetails: {
                traceTypeCode: "1",
                checkOrEFTTraceNumber: `EFT${cl.payerClaimControlNumber.slice(-8)}`,
                originatingCompanyIdentifier: "1999999999",
              },
              payer: { name: payer.displayName, payerIdentifier: payer.primaryPayerId },
              payee: { name: cl.providerName, npi: cl.providerNpi },
              detailInfo: [
                {
                  assignedNumber: "1",
                  paymentInfo: [
                    {
                      claimPaymentInfo: {
                        patientControlNumber: cl.patientControlNumber,
                        claimStatusCode: cl.paidAmount > 0 ? "1" : "4",
                        totalClaimChargeAmount: money(cl.chargeAmount),
                        claimPaymentAmount: money(cl.paidAmount),
                        patientResponsibilityAmount: "0.00",
                        claimFilingIndicatorCode: "CI",
                        payerClaimControlNumber: cl.payerClaimControlNumber,
                      },
                      patientName: {
                        lastName: member?.lastName ?? "",
                        firstName: member?.firstName ?? "",
                        memberId: cl.memberId,
                      },
                      serviceLines: cl.serviceLines.map((l) => ({
                        servicePaymentInformation: {
                          productOrServiceIDQualifier: "HC",
                          adjudicatedProcedureCode: l.procedureCode,
                          lineItemChargeAmount: money(l.charge),
                          lineItemProviderPaymentAmount: money(l.paid),
                        },
                        serviceDate: cl.serviceDate,
                        ...(l.charge > l.paid
                          ? {
                              serviceAdjustments: [
                                {
                                  claimAdjustmentGroupCode: l.paid > 0 ? "CO" : "PR",
                                  adjustmentReasonCode1: l.paid > 0 ? "45" : "27",
                                  adjustmentAmount1: money(l.charge - l.paid),
                                },
                              ],
                            }
                          : {}),
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        });
      }),
    );

    // Transactions, as the Stedi core API lists them.
    app.get("/2023-08-01/transactions", (c) => {
      const size = Math.min(Math.max(Number(c.req.query("pageSize") ?? 100) || 100, 1), 500);
      const offset = Number(Buffer.from(c.req.query("pageToken") ?? "", "base64url").toString() || 0) || 0;
      const items = [...d().claims].reverse().map((cl) => ({
        transactionId: cl.transactionId,
        direction: "INBOUND",
        mode: "test",
        status: "succeeded",
        businessIdentifier: cl.patientControlNumber,
        x12: { transactionSetIdentifier: "835", metadata: { transaction: { controlNumber: "0001" } } },
        createdAt: cl.submittedAt,
        processedAt: cl.submittedAt,
      }));
      const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : undefined;
      return c.json({ items: items.slice(offset, offset + size), ...(next ? { nextPageToken: next } : {}) });
    });

    app.get("/_inspector", (c) => {
      const tab = c.req.query("tab") === "claims" ? "claims" : "members";
      const tabs = [
        { id: "members", label: `Members (${d().members.length})`, href: "/_inspector" },
        { id: "claims", label: `Claims (${d().claims.length})`, href: "/_inspector?tab=claims" },
      ];
      const head =
        tab === "members"
          ? ["member id", "payer", "name", "date of birth"]
          : ["patient control number", "payer", "member", "charged", "paid", "835 transaction"];
      const rows =
        tab === "members"
          ? d().members.map((m) => [m.memberId, m.payerId, `${m.firstName} ${m.lastName}`, m.dateOfBirth])
          : d().claims.map((cl) => [
              cl.patientControlNumber,
              cl.payerId,
              cl.memberId,
              money(cl.chargeAmount),
              money(cl.paidAmount),
              cl.transactionId,
            ]);
      const html = `<div class="inspector-section"><h2>${tab === "members" ? "Members" : "Claims"}</h2><p>Payers: ${PAYERS.map((p) => `${escapeHtml(p.displayName)} (${p.primaryPayerId})`).join(", ")}.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${head
        .map((h) => `<th>${escapeHtml(h)}</th>`)
        .join("")}</tr></thead><tbody>${
        rows.length
          ? rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")
          : `<tr><td colspan="${head.length}"><div class="inspector-empty">Nothing yet</div></td></tr>`
      }</tbody></table></div></div>`;
      return c.html(renderInspectorPage("Stedi inspector", tabs, tab, html, SERVICE_LABEL));
    });
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, { apiKeys: [], members: membersFrom(), claims: [] });
  },
};

export default stediPlugin;
