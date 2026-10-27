// A clinic's billing flow through a clearinghouse: check eligibility, submit a professional claim, follow its
// status, and read the remittance (835), with Stedi's JSON APIs.

export interface Clearinghouse {
  baseUrl: string;
  apiKey: string;
}

const V = "/2024-04-01/change/medicalnetwork";
export const CLINIC = { organizationName: "Synthetic Health Clinic", npi: "0000000016" };

async function call(ch: Clearinghouse, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ch.baseUrl}${path}`, {
    method,
    headers: { Authorization: ch.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  return json;
}

export interface Eligibility {
  active: boolean;
  subscriber: { memberId: string; firstName: string; lastName: string; dateOfBirth: string; gender?: string };
  copay?: string;
}

export async function checkEligibility(ch: Clearinghouse, payerId: string, memberId: string): Promise<Eligibility> {
  const res = await call(ch, "POST", `${V}/eligibility/v3`, {
    controlNumber: "000000001",
    tradingPartnerServiceId: payerId,
    provider: CLINIC,
    subscriber: { memberId },
    encounter: { serviceTypeCodes: ["30"] },
  });
  if (res.errors?.length)
    return { active: false, subscriber: { memberId, firstName: "", lastName: "", dateOfBirth: "" } };
  const benefits = (res.benefitsInformation ?? []) as Array<{ code: string; benefitAmount?: string }>;
  return {
    active: benefits.some((b) => b.code === "1"),
    subscriber: { ...res.subscriber, memberId },
    copay: benefits.find((b) => b.code === "B")?.benefitAmount,
  };
}

export interface Line {
  code: string;
  charge: number;
}

export async function submitClaim(
  ch: Clearinghouse,
  payerId: string,
  subscriber: Eligibility["subscriber"],
  claim: { controlNumber: string; date: string; diagnosis: string; lines: Line[] },
): Promise<string> {
  const total = claim.lines.reduce((sum, l) => sum + l.charge, 0);
  const res = await call(ch, "POST", `${V}/professionalclaims/v3/submission`, {
    controlNumber: "000000002",
    tradingPartnerServiceId: payerId,
    submitter: {
      organizationName: CLINIC.organizationName,
      contactInformation: { name: "Billing", phoneNumber: "5550100" },
    },
    receiver: { organizationName: "Synthetic Health Plan" },
    subscriber: { ...subscriber, paymentResponsibilityLevelCode: "P" },
    billing: {
      providerType: "BillingProvider",
      npi: CLINIC.npi,
      employerId: "000000000",
      organizationName: CLINIC.organizationName,
    },
    claimInformation: {
      claimFilingCode: "CI",
      patientControlNumber: claim.controlNumber,
      claimChargeAmount: total.toFixed(2),
      placeOfServiceCode: "11",
      claimFrequencyCode: "1",
      signatureIndicator: "Y",
      planParticipationCode: "A",
      benefitsAssignmentCertificationIndicator: "Y",
      releaseInformationCode: "Y",
      healthCareCodeInformation: [{ diagnosisTypeCode: "ABK", diagnosisCode: claim.diagnosis }],
      serviceLines: claim.lines.map((l) => ({
        serviceDate: claim.date,
        professionalService: {
          procedureIdentifier: "HC",
          procedureCode: l.code,
          lineItemChargeAmount: l.charge.toFixed(2),
          measurementUnit: "UN",
          serviceUnitCount: "1",
          compositeDiagnosisCodePointers: { diagnosisCodePointers: ["1"] },
        },
      })),
    },
  });
  return res.claimReference.patientControlNumber;
}

export interface ClaimOutcome {
  category: string;
  paid: number;
  submitted: number;
}

export async function claimStatus(
  ch: Clearinghouse,
  payerId: string,
  subscriber: Eligibility["subscriber"],
  controlNumber: string,
  date: string,
): Promise<ClaimOutcome> {
  const res = await call(ch, "POST", `${V}/claimstatus/v2`, {
    controlNumber: "000000003",
    tradingPartnerServiceId: payerId,
    providers: [{ ...CLINIC, providerType: "BillingProvider" }],
    subscriber,
    encounter: { beginningDateOfService: date, endDateOfService: date, trackingNumber: controlNumber },
  });
  const status = res.claims[0].claimStatus;
  return {
    category: status.statusCategoryCode,
    paid: Number(status.amountPaid ?? 0),
    submitted: Number(status.submittedAmount ?? 0),
  };
}

/** The remittance for a claim: total paid and the contractual adjustment per line. */
export async function remittance(
  ch: Clearinghouse,
  controlNumber: string,
): Promise<{ paid: number; adjustments: number[] }> {
  const list = await call(ch, "GET", "/2023-08-01/transactions");
  for (const item of list.items ?? []) {
    const era = await call(ch, "GET", `${V}/reports/v2/${item.transactionId}/835`);
    const payment = era.transactions?.[0]?.detailInfo?.[0]?.paymentInfo?.find(
      (p: any) => p.claimPaymentInfo?.patientControlNumber === controlNumber,
    );
    if (payment)
      return {
        paid: Number(payment.claimPaymentInfo.claimPaymentAmount),
        adjustments: payment.serviceLines.map((l: any) => Number(l.serviceAdjustments?.[0]?.adjustmentAmount1 ?? 0)),
      };
  }
  throw new Error(`No remittance for ${controlNumber}`);
}
