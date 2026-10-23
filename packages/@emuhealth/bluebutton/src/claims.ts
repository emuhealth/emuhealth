import type { FhirResource } from "@emuhealth/fhir-core";
import { SYNTHETIC_TAG } from "@emuhealth/fhir-core";

// Synthetic Medicare claims for the generated patients: Part A, B, and D Coverage, carrier ExplanationOfBenefit
// claims for each encounter, and Part D (PDE) claims for each prescription. Line items use HCPCS Level II codes
// (public domain, CMS) rather than CPT, which emuhealth does not bundle.

const BB = "https://bluebutton.cms.gov/resources";
const EOB_TYPE = `${BB}/codesystem/eob-type`;
const CLAIM_TYPE = "http://terminology.hl7.org/CodeSystem/claim-type";
const HCPCS = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";
const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
const MBI = "http://hl7.org/fhir/sid/us-mbi";

const VISIT_LINES = [
  { code: "G0439", display: "Annual wellness visit, subsequent", amount: 135.5 },
  { code: "G0008", display: "Administration of influenza virus vaccine", amount: 25.0 },
  { code: "G0444", display: "Annual depression screening, 5 to 15 minutes", amount: 18.25 },
];

const tagged = (r: FhirResource): FhirResource => ({ ...r, meta: { tag: [SYNTHETIC_TAG] } });
const money = (value: number) => ({ value: Number(value.toFixed(2)), currency: "USD" });

/**
 * A synthetic Medicare Beneficiary Identifier in the MBI layout. Real MBIs never contain the letter S, so these
 * cannot collide with a real beneficiary.
 */
export function syntheticMbi(n: number): string {
  return `1S${String(n).padStart(2, "0")}A00AA${String(n % 100).padStart(2, "0")}`;
}

const refId = (ref: unknown) =>
  String((ref as { reference?: string } | undefined)?.reference ?? "").split("/")[1] ?? "";

export function claimsFor(records: FhirResource[]): FhirResource[] {
  const out: FhirResource[] = [];
  const patients = records.filter((r) => r.resourceType === "Patient");
  const forPatient = (type: string, id: string) =>
    records.filter((r) => r.resourceType === type && (refId(r.subject) === id || refId(r.patient) === id));
  for (const [index, patient] of patients.entries()) {
    const id = patient.id!;
    const subject = { reference: `Patient/${id}` };
    // Medicare identifiers on the Patient, as Blue Button returns them.
    patient.identifier = [
      ...((patient.identifier as unknown[]) ?? []),
      { system: MBI, value: syntheticMbi(index + 1) },
    ];
    for (const part of ["A", "B", "D"] as const) {
      out.push(
        tagged({
          resourceType: "Coverage",
          id: `part-${part.toLowerCase()}-${id}`,
          status: "active",
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                code: "SUBSIDIZ",
                display: "subsidized health program",
              },
            ],
          },
          subscriberId: syntheticMbi(index + 1),
          beneficiary: subject,
          relationship: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/subscriber-relationship",
                code: "self",
                display: "Self",
              },
            ],
          },
          period: { start: "2020-01-01" },
          payor: [{ identifier: { value: "Centers for Medicare and Medicaid Services" } }],
          class: [
            {
              type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "group" }] },
              value: "Medicare",
              name: "Medicare",
            },
            {
              type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] },
              value: `Part ${part}`,
              name: `Part ${part}`,
            },
          ],
        }),
      );
    }
    const diagnoses = forPatient("Condition", id).map((c, i) => ({
      sequence: i + 1,
      diagnosisCodeableConcept: c.code,
      type: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/ex-diagnosistype",
              code: i === 0 ? "principal" : "secondary",
            },
          ],
        },
      ],
    }));
    for (const [e, encounter] of forPatient("Encounter", id).entries()) {
      const period = encounter.period as { start: string; end: string };
      const lines = VISIT_LINES.slice(0, 1 + (e % VISIT_LINES.length));
      const total = lines.reduce((sum, l) => sum + l.amount, 0);
      out.push(
        tagged({
          resourceType: "ExplanationOfBenefit",
          id: `carrier-${encounter.id}`,
          status: "active",
          type: {
            coding: [
              { system: EOB_TYPE, code: "CARRIER", display: "Carrier claim" },
              { system: CLAIM_TYPE, code: "professional", display: "Professional" },
            ],
          },
          use: "claim",
          patient: subject,
          billablePeriod: { start: period.start.slice(0, 10), end: period.end.slice(0, 10) },
          created: period.end,
          insurer: { identifier: { value: "CMS" } },
          provider: {
            reference: String((encounter.serviceProvider as { reference?: string } | undefined)?.reference ?? ""),
          },
          outcome: "complete",
          insurance: [{ focal: true, coverage: { reference: `Coverage/part-b-${id}` } }],
          ...(diagnoses.length
            ? {
                diagnosis: diagnoses.map((d) => ({
                  ...d,
                  diagnosisCodeableConcept: {
                    coding: (
                      (d.diagnosisCodeableConcept as { coding?: Array<{ system?: string }> }).coding ?? []
                    ).filter((c) => c.system === ICD10),
                  },
                })),
              }
            : {}),
          item: lines.map((l, i) => ({
            sequence: i + 1,
            productOrService: { coding: [{ system: HCPCS, code: l.code, display: l.display }] },
            servicedPeriod: { start: period.start.slice(0, 10), end: period.end.slice(0, 10) },
            net: money(l.amount),
            adjudication: [
              {
                category: {
                  coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "submitted" }],
                },
                amount: money(l.amount),
              },
              {
                category: {
                  coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "benefit" }],
                },
                amount: money(l.amount * 0.8),
              },
            ],
          })),
          total: [
            {
              category: {
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "submitted" }],
              },
              amount: money(total),
            },
          ],
          payment: { amount: money(total * 0.8) },
        }),
      );
    }
    for (const prescription of forPatient("MedicationRequest", id)) {
      const filled = String(prescription.authoredOn ?? "2025-01-01");
      out.push(
        tagged({
          resourceType: "ExplanationOfBenefit",
          id: `pde-${prescription.id}`,
          status: "active",
          type: {
            coding: [
              { system: EOB_TYPE, code: "PDE", display: "Part D event" },
              { system: CLAIM_TYPE, code: "pharmacy", display: "Pharmacy" },
            ],
          },
          use: "claim",
          patient: subject,
          billablePeriod: { start: filled, end: filled },
          created: `${filled}T12:00:00Z`,
          insurer: { identifier: { value: "CMS" } },
          provider: { identifier: { value: "Synthetic Pharmacy" } },
          outcome: "complete",
          insurance: [{ focal: true, coverage: { reference: `Coverage/part-d-${id}` } }],
          item: [
            {
              sequence: 1,
              productOrService: {
                coding: (
                  (prescription.medicationCodeableConcept as { coding?: Array<{ system?: string }> }).coding ?? []
                ).filter((c) => c.system === RXNORM),
              },
              servicedDate: filled,
              quantity: { value: 30 },
              net: money(12.5),
            },
          ],
          total: [
            {
              category: {
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "submitted" }],
              },
              amount: money(12.5),
            },
          ],
          payment: { amount: money(10) },
        }),
      );
    }
  }
  return out;
}
