import { SYNTHETIC_TAG, type FhirResource } from "@emuhealth/fhir-core";

// Member data for the patient access API, shaped by the CARIN Consumer Directed Payer Data Exchange IG (CARIN Blue
// Button): members with a member id, Coverage, the payer Organization, and professional (non-clinician)
// ExplanationOfBenefit claims for each finished encounter. Lines use HCPCS Level II codes, which are public;
// emuhealth does not bundle CPT, NUBC, or NDC codes, so institutional and pharmacy claims are not generated.

export const PAYER_ID = "syn-payer";
export const MEMBER_ID_SYSTEM = "urn:emuhealth:synthetic:payer:member-id";
const CARIN = "http://hl7.org/fhir/us/carin-bb";
const C4BB = `${CARIN}/StructureDefinition`;
const C4BB_CS = `${CARIN}/CodeSystem`;
const HCPCS = "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";
const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
const POS = "https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set";
const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";

const LINES = [
  { code: "G0439", display: "Annual wellness visit, subsequent", amount: 165 },
  { code: "G0008", display: "Administration of influenza virus vaccine", amount: 32 },
  { code: "G0444", display: "Annual depression screening, 5 to 15 minutes", amount: 24 },
];

// CARIN asks for a versioned profile canonical; the data follows STU 2.1.
const meta = (profile: string) => ({ profile: [`${C4BB}/${profile}|2.1.0`], tag: [SYNTHETIC_TAG] });
const ADJUDICATION = "http://terminology.hl7.org/CodeSystem/adjudication";
/** CARIN requires a diagnosis on every claim; members with no recorded conditions get a routine exam. */
const ROUTINE_EXAM = {
  system: "http://hl7.org/fhir/sid/icd-10-cm",
  code: "Z00.00",
  display: "Encounter for general adult medical examination without abnormal findings",
};
const money = (value: number) => ({ value: Number(value.toFixed(2)), currency: "USD" });
const refId = (ref: unknown) =>
  String((ref as { reference?: string } | undefined)?.reference ?? "").split("/")[1] ?? "";

/** A synthetic member id; the SYNM prefix keeps it apart from any real plan's ids. */
export const memberId = (n: number) => `SYNM${String(n).padStart(7, "0")}`;

export function payerOrganization(): FhirResource {
  return {
    resourceType: "Organization",
    id: PAYER_ID,
    meta: meta("C4BB-Organization"),
    identifier: [
      {
        type: { coding: [{ system: C4BB_CS + "/C4BBIdentifierType", code: "payerid" }] },
        system: "urn:emuhealth:synthetic:payer-id",
        value: "SYNPAYER01",
      },
    ],
    active: true,
    type: [
      {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/organization-type", code: "pay", display: "Payer" }],
      },
    ],
    name: "Synthetic Health Plan",
    telecom: [{ system: "phone", value: "555-0190", use: "work" }],
    address: [
      { use: "work", line: ["1 Example Plaza"], city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
    ],
  };
}

/** Patients become members, each with a Coverage and claims for their finished encounters. */
export function memberRecords(records: FhirResource[]): FhirResource[] {
  const out: FhirResource[] = [payerOrganization()];
  const patients = records.filter((r) => r.resourceType === "Patient");
  const conditions = records.filter((r) => r.resourceType === "Condition");
  for (const [index, source] of patients.entries()) {
    const n = index + 1;
    const pid = source.id!;
    const member = memberId(n);
    const patient: FhirResource = {
      ...source,
      meta: meta("C4BB-Patient"),
      identifier: [
        ...((source.identifier as unknown[]) ?? []),
        {
          type: { coding: [{ system: V2_0203, code: "MB", display: "Member Number" }] },
          system: MEMBER_ID_SYSTEM,
          value: member,
        },
      ],
    };
    out.push(patient);
    const coverage = `coverage-${pid}`;
    out.push({
      resourceType: "Coverage",
      id: coverage,
      meta: meta("C4BB-Coverage"),
      identifier: [
        {
          type: { coding: [{ system: V2_0203, code: "MB", display: "Member Number" }] },
          system: MEMBER_ID_SYSTEM,
          value: member,
        },
      ],
      status: "active",
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            code: "HIP",
            display: "health insurance plan policy",
          },
        ],
      },
      subscriberId: member,
      beneficiary: { reference: `Patient/${pid}` },
      relationship: {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/subscriber-relationship", code: "self", display: "Self" },
        ],
      },
      period: { start: "2024-01-01" },
      payor: [{ reference: `Organization/${PAYER_ID}` }],
      class: [
        {
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "group" }] },
          value: "SYN-GROUP-100",
          name: "Synthetic Employer Group",
        },
        {
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] },
          value: "SYN-PPO-GOLD",
          name: "Synthetic PPO Gold",
        },
      ],
    });
    const encounters = records.filter(
      (r) => r.resourceType === "Encounter" && refId(r.subject) === pid && r.status === "finished",
    );
    const diagnoses = conditions.filter((c) => refId(c.subject) === pid).slice(0, 4);
    for (const [e, encounter] of encounters.entries()) {
      const period = encounter.period as { start: string; end?: string };
      const date = period.start.slice(0, 10);
      const line = LINES[(n + e) % LINES.length];
      const allowed = line.amount * 0.8;
      const paid = allowed * 0.9;
      const practitioner = (encounter.participant as Array<{ individual?: { reference: string } }> | undefined)?.[0]
        ?.individual;
      out.push({
        resourceType: "ExplanationOfBenefit",
        id: `eob-${encounter.id}`,
        meta: { ...meta("C4BB-ExplanationOfBenefit-Professional-NonClinician"), lastUpdated: `${date}T12:00:00Z` },
        identifier: [
          {
            type: { coding: [{ system: `${C4BB_CS}/C4BBIdentifierType`, code: "uc", display: "Unique Claim ID" }] },
            system: "urn:emuhealth:synthetic:payer:claim-id",
            value: `SYNCLM-${String(n).padStart(3, "0")}-${String(e + 1).padStart(3, "0")}`,
          },
        ],
        status: "active",
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/claim-type",
              code: "professional",
              display: "Professional",
            },
          ],
        },
        use: "claim",
        patient: { reference: `Patient/${pid}` },
        billablePeriod: { start: date, end: (period.end ?? period.start).slice(0, 10) },
        created: `${date}T12:00:00Z`,
        insurer: { reference: `Organization/${PAYER_ID}` },
        provider: practitioner ?? { reference: "Organization/syn-organization-1" },
        outcome: "complete",
        careTeam: practitioner
          ? [
              {
                sequence: 1,
                provider: practitioner,
                role: {
                  coding: [
                    { system: `${C4BB_CS}/C4BBClaimCareTeamRole`, code: "performing", display: "Performing provider" },
                  ],
                },
              },
            ]
          : undefined,
        supportingInfo: [
          {
            sequence: 1,
            category: { coding: [{ system: `${C4BB_CS}/C4BBSupportingInfoType`, code: "clmrecvddate" }] },
            timingDate: date,
          },
        ],
        diagnosis: (diagnoses.length
          ? diagnoses.map((c) =>
              ((c.code as { coding?: Array<{ system: string }> }).coding ?? []).filter((x) => x.system === ICD10),
            )
          : [[ROUTINE_EXAM]]
        ).map((coding, d) => ({
          sequence: d + 1,
          diagnosisCodeableConcept: { coding },
          type: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/ex-diagnosistype",
                  code: d === 0 ? "principal" : "secondary",
                },
              ],
            },
          ],
        })),
        insurance: [{ focal: true, coverage: { reference: `Coverage/${coverage}` } }],
        // CARIN 2.x reports the billing provider's network status in header level adjudication.
        adjudication: [
          {
            category: {
              coding: [{ system: `${C4BB_CS}/C4BBAdjudicationDiscriminator`, code: "billingnetworkstatus" }],
            },
            reason: { coding: [{ system: `${C4BB_CS}/C4BBPayerProviderNetworkStatus`, code: "innetwork" }] },
          },
        ],
        item: [
          {
            sequence: 1,
            diagnosisSequence: [1],
            productOrService: { coding: [{ system: HCPCS, code: line.code, display: line.display }] },
            servicedDate: date,
            locationCodeableConcept: { coding: [{ system: POS, code: "11", display: "Office" }] },
            adjudication: [
              {
                category: { coding: [{ system: ADJUDICATION, code: "submitted" }] },
                amount: money(line.amount),
              },
              {
                category: {
                  coding: [{ system: ADJUDICATION, code: "eligible" }],
                },
                amount: money(allowed),
              },
              {
                category: { coding: [{ system: `${C4BB_CS}/C4BBAdjudication`, code: "paidtoprovider" }] },
                amount: money(paid),
              },
              {
                category: {
                  coding: [{ system: `${C4BB_CS}/C4BBAdjudicationDiscriminator`, code: "benefitpaymentstatus" }],
                },
                reason: { coding: [{ system: `${C4BB_CS}/C4BBPayerBenefitPaymentStatus`, code: "innetwork" }] },
              },
            ],
          },
        ],
        total: [
          {
            category: { coding: [{ system: ADJUDICATION, code: "submitted" }] },
            amount: money(line.amount),
          },
          {
            category: { coding: [{ system: ADJUDICATION, code: "eligible" }] },
            amount: money(allowed),
          },
          {
            category: { coding: [{ system: `${C4BB_CS}/C4BBAdjudication`, code: "paidtoprovider" }] },
            amount: money(paid),
          },
        ],
        payment: { date, amount: money(paid) },
      });
    }
  }
  // Drop undefined optional fields so JSON stays clean.
  return JSON.parse(JSON.stringify(out));
}
