import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { membersFrom, seedFromConfig, stediPlugin, type StediSeedConfig } from "../index.js";

const origin = "http://localhost:4117";
const V = "/2024-04-01/change/medicalnetwork";

function startService(config?: StediSeedConfig) {
  const app = new Hono();
  const store = new Store();
  stediPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  stediPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  return async (method: string, path: string, body?: unknown, key: string | null = "test_synthetic_key") => {
    const res = await app.request(`${origin}${path}`, {
      method,
      headers: { ...(key ? { Authorization: key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
}

const member = membersFrom()[0];
const provider = { organizationName: "Synthetic Health Clinic", npi: "0000000016" };

const claim = (overrides: Record<string, unknown> = {}) => ({
  controlNumber: "000000001",
  tradingPartnerServiceId: member.payerId,
  submitter: {
    organizationName: "Synthetic Health Clinic",
    contactInformation: { name: "Billing", phoneNumber: "5550100" },
  },
  receiver: { organizationName: "Synthetic Health Plan" },
  subscriber: {
    memberId: member.memberId,
    paymentResponsibilityLevelCode: "P",
    firstName: member.firstName,
    lastName: member.lastName,
    gender: member.gender,
    dateOfBirth: member.dateOfBirth,
  },
  billing: {
    providerType: "BillingProvider",
    npi: provider.npi,
    employerId: "000000000",
    organizationName: provider.organizationName,
  },
  claimInformation: {
    claimFilingCode: "CI",
    patientControlNumber: "PCN-0001",
    claimChargeAmount: "160.75",
    placeOfServiceCode: "11",
    claimFrequencyCode: "1",
    signatureIndicator: "Y",
    planParticipationCode: "A",
    benefitsAssignmentCertificationIndicator: "Y",
    releaseInformationCode: "Y",
    healthCareCodeInformation: [{ diagnosisTypeCode: "ABK", diagnosisCode: "I10" }],
    serviceLines: [
      {
        serviceDate: "20250610",
        professionalService: {
          procedureIdentifier: "HC",
          procedureCode: "G0439",
          lineItemChargeAmount: "135.75",
          measurementUnit: "UN",
          serviceUnitCount: "1",
          compositeDiagnosisCodePointers: { diagnosisCodePointers: ["1"] },
        },
      },
      {
        serviceDate: "20250610",
        professionalService: {
          procedureIdentifier: "HC",
          procedureCode: "G0008",
          lineItemChargeAmount: "25.00",
          measurementUnit: "UN",
          serviceUnitCount: "1",
          compositeDiagnosisCodePointers: { diagnosisCodePointers: ["1"] },
        },
      },
    ],
  },
  ...overrides,
});

describe("Stedi", () => {
  it("requires an API key, with or without the Key prefix", async () => {
    const call = startService();
    expect((await call("GET", "/2024-04-01/payers", undefined, null)).status).toBe(401);
    expect((await call("GET", "/2024-04-01/payers", undefined, "Key test_synthetic_key")).status).toBe(200);
    const locked = startService({ apiKeys: ["right"] });
    expect((await locked("GET", "/2024-04-01/payers", undefined, "wrong")).status).toBe(401);
  });

  it("checks eligibility and reports unknown members the 271 way", async () => {
    const call = startService();
    const res = await call("POST", `${V}/eligibility/v3`, {
      controlNumber: "123456789",
      tradingPartnerServiceId: member.payerId,
      provider,
      subscriber: { memberId: member.memberId },
      encounter: { serviceTypeCodes: ["30", "98"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.subscriber).toMatchObject({ memberId: member.memberId, lastName: member.lastName });
    expect(res.body.planStatus[0].statusCode).toBe("1");
    const names = res.body.benefitsInformation.map((b: { name: string }) => b.name);
    expect(names).toEqual(expect.arrayContaining(["Active Coverage", "Deductible", "Co-Payment", "Co-Insurance"]));
    const byName = await call("POST", `${V}/eligibility/v3`, {
      tradingPartnerServiceId: member.payerId,
      provider,
      subscriber: { lastName: member.lastName, dateOfBirth: member.dateOfBirth },
    });
    expect(byName.body.subscriber.memberId).toBe(member.memberId);
    const unknown = await call("POST", `${V}/eligibility/v3`, {
      tradingPartnerServiceId: member.payerId,
      provider,
      subscriber: { memberId: "NOPE" },
    });
    expect(unknown.body.errors[0]).toMatchObject({ code: "75", description: "Subscriber/Insured Not Found" });
    expect(
      (await call("POST", `${V}/eligibility/v3`, { tradingPartnerServiceId: "XYZ", provider, subscriber: {} })).status,
    ).toBe(400);
  });

  it("submits a claim, finalizes it in claim status, and returns an 835", async () => {
    const call = startService();
    const submitted = await call("POST", `${V}/professionalclaims/v3/submission`, claim());
    expect(submitted.body).toMatchObject({
      status: "SUCCESS",
      claimReference: { patientControlNumber: "PCN-0001", claimType: "PRO" },
    });
    const status = await call("POST", `${V}/claimstatus/v2`, {
      controlNumber: "000000002",
      tradingPartnerServiceId: member.payerId,
      providers: [{ organizationName: provider.organizationName, npi: provider.npi, providerType: "BillingProvider" }],
      subscriber: {
        memberId: member.memberId,
        firstName: member.firstName,
        lastName: member.lastName,
        dateOfBirth: member.dateOfBirth,
      },
      encounter: { beginningDateOfService: "20250601", endDateOfService: "20250630" },
    });
    const claimStatus = status.body.claims[0].claimStatus;
    expect(claimStatus).toMatchObject({
      statusCategoryCode: "F1",
      submittedAmount: "160.75",
      trackingNumber: "PCN-0001",
    });
    expect(Number(claimStatus.amountPaid)).toBeGreaterThan(0);
    const transactions = await call("GET", "/2023-08-01/transactions");
    const transactionId = transactions.body.items[0].transactionId;
    const era = await call("GET", `${V}/reports/v2/${transactionId}/835`);
    const payment = era.body.transactions[0].detailInfo[0].paymentInfo[0];
    expect(payment.claimPaymentInfo).toMatchObject({
      patientControlNumber: "PCN-0001",
      totalClaimChargeAmount: "160.75",
      claimStatusCode: "1",
    });
    expect(payment.serviceLines[0].serviceAdjustments[0]).toMatchObject({
      claimAdjustmentGroupCode: "CO",
      adjustmentReasonCode1: "45",
    });
    const none = await call("POST", `${V}/claimstatus/v2`, {
      tradingPartnerServiceId: member.payerId,
      subscriber: { memberId: member.memberId },
      encounter: { beginningDateOfService: "20200101", endDateOfService: "20200131" },
    });
    expect(none.body.claims[0].claimStatus.statusCategoryCode).toBe("A4");
  });

  it("rejects incomplete or unbalanced claims", async () => {
    const call = startService();
    const missing = await call("POST", `${V}/professionalclaims/v3/submission`, {
      tradingPartnerServiceId: member.payerId,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("submitter");
    const unbalanced = claim();
    (unbalanced.claimInformation as Record<string, unknown>).claimChargeAmount = "999.00";
    expect((await call("POST", `${V}/professionalclaims/v3/submission`, unbalanced)).body.message).toContain(
      "does not equal",
    );
  });
});
