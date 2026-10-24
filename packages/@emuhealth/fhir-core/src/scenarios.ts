import type { FhirResource } from "./store.js";

// Scenario packs: named clinical stories added to one generated patient. They are part of the generator, so every
// service that draws on the shared population (decision 0018) sees the same story: FHIR records here, a diabetic
// glucose curve in the device emulators, an inpatient visit in the HL7 v2 registry, and a serious adverse event on
// the linked Rave subject. Records use fixed ids and dates relative to the reference date and leave the random
// streams alone, so adding a scenario does not change any other record.

export type ScenarioName = "diabetes-cgm" | "inpatient-stay" | "trial-adverse-event";

export interface ScenarioRequest {
  name: ScenarioName;
  /** The patient it applies to, such as syn-patient-004. */
  patient?: string;
}

export const SCENARIOS: Record<ScenarioName, { description: string; defaultPatient: number }> = {
  "diabetes-cgm": {
    description: "Type 2 diabetes on metformin with rising HbA1c and a continuous glucose monitor",
    defaultPatient: 1,
  },
  "inpatient-stay": {
    description: "A three day admission for pneumonia, with a discharge summary",
    defaultPatient: 2,
  },
  "trial-adverse-event": {
    description: "Enrolled in study EMU-101 with a serious adverse event (syncope)",
    defaultPatient: 3,
  },
};

const LOINC = "http://loinc.org";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
const ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const DAY = 86_400_000;

/** Codes scenarios add beyond the generator's own; they join the terminology fixtures. */
export const SCENARIO_CODES = {
  icd10: [
    { code: "J18.9", display: "Pneumonia, unspecified organism" },
    { code: "R55", display: "Syncope and collapse" },
  ],
  loinc: [{ code: "2339-0", display: "Glucose [Mass/volume] in Blood" }],
};

export function parseScenarios(input: unknown, patients: number): Array<{ name: ScenarioName; patientId: string }> {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("generate.scenarios must be an array of scenario names or { name, patient }");
  return input.map((item, i) => {
    const request: ScenarioRequest = typeof item === "string" ? { name: item as ScenarioName } : item;
    if (!request || typeof request !== "object" || !(request.name in SCENARIOS))
      throw new Error(`generate.scenarios[${i}] must name one of ${Object.keys(SCENARIOS).join(", ")}`);
    const patientId =
      request.patient ?? `syn-patient-${String(SCENARIOS[request.name].defaultPatient).padStart(3, "0")}`;
    const n = Number(/^syn-patient-(\d{3,})$/.exec(patientId)?.[1]);
    if (!n || n > patients)
      throw new Error(`generate.scenarios[${i}]: ${patientId} is not one of the ${patients} generated patients`);
    return { name: request.name, patientId };
  });
}

const tag = { tag: [{ system: "urn:emuhealth:tag", code: "synthetic", display: "Synthetic data" }] };
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const date = (ms: number) => iso(ms).slice(0, 10);

function diabetesCgm(pid: string, short: string, reference: number, has: Set<string>): FhirResource[] {
  const subject = { reference: `Patient/${pid}` };
  const out: FhirResource[] = [];
  if (!has.has("E11.9"))
    out.push(
      {
        resourceType: "Condition",
        id: `syn-condition-${short}-scn-diabetes`,
        meta: tag,
        clinicalStatus: {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
        },
        verificationStatus: {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
        },
        category: [
          {
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }],
          },
        ],
        code: { coding: [{ system: ICD10, code: "E11.9", display: "Type 2 diabetes mellitus without complications" }] },
        subject,
        onsetDateTime: date(reference - 900 * DAY),
        recordedDate: date(reference - 900 * DAY),
      },
      {
        resourceType: "MedicationRequest",
        id: `syn-medicationrequest-${short}-scn-metformin`,
        meta: tag,
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [{ system: RXNORM, code: "861007", display: "metformin hydrochloride 500 MG Oral Tablet" }],
        },
        subject,
        authoredOn: date(reference - 900 * DAY),
        dosageInstruction: [{ text: "1 tablet by mouth twice daily with meals" }],
      },
    );
  // HbA1c every quarter, drifting up: the reason for the glucose monitor.
  [7.4, 7.7, 8.1, 8.4].forEach((value, i) =>
    out.push({
      resourceType: "Observation",
      id: `syn-observation-${short}-scn-a1c-${i + 1}`,
      meta: tag,
      status: "final",
      category: [
        {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }],
        },
      ],
      code: { coding: [{ system: LOINC, code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" }] },
      subject,
      effectiveDateTime: iso(reference - (360 - i * 90) * DAY + 9 * 3_600_000),
      valueQuantity: { value, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
    }),
  );
  out.push({
    resourceType: "Device",
    id: `syn-device-${short}-scn-cgm`,
    meta: tag,
    status: "active",
    manufacturer: "Synthetic Sensors",
    deviceName: [{ name: "Synthetic continuous glucose monitor", type: "user-friendly-name" }],
    type: { text: "Continuous glucose monitoring system" },
    patient: subject,
  });
  return out;
}

function inpatientStay(pid: string, short: string, reference: number): FhirResource[] {
  const subject = { reference: `Patient/${pid}` };
  const admitted = reference - 40 * DAY + 14 * 3_600_000;
  const discharged = admitted + 3 * DAY - 4 * 3_600_000;
  const encounter = `syn-encounter-${short}-scn-inpatient`;
  const pneumonia = { system: ICD10, code: "J18.9", display: "Pneumonia, unspecified organism" };
  const summary = `Discharge summary (synthetic). Admitted for community acquired pneumonia, treated, discharged home.`;
  return [
    {
      resourceType: "Encounter",
      id: encounter,
      meta: tag,
      identifier: [{ system: "urn:emuhealth:synthetic:visit", value: `V-${short}-INPT` }],
      status: "finished",
      class: { system: ACT_CODE, code: "IMP", display: "inpatient encounter" },
      type: [{ text: "Inpatient admission" }],
      subject,
      participant: [{ individual: { reference: "Practitioner/syn-practitioner-1" } }],
      period: { start: iso(admitted), end: iso(discharged) },
      reasonCode: [{ coding: [pneumonia] }],
      hospitalization: {
        admitSource: { text: "Emergency department" },
        dischargeDisposition: {
          coding: [
            { system: "http://terminology.hl7.org/CodeSystem/discharge-disposition", code: "home", display: "Home" },
          ],
        },
      },
      location: [{ location: { reference: "Location/syn-location-1", display: "3W ward, room 312" } }],
      serviceProvider: { reference: "Organization/syn-organization-1" },
    },
    {
      resourceType: "Condition",
      id: `syn-condition-${short}-scn-pneumonia`,
      meta: tag,
      clinicalStatus: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "resolved" }],
      },
      verificationStatus: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
      },
      category: [
        {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }],
        },
      ],
      code: { coding: [pneumonia] },
      subject,
      encounter: { reference: `Encounter/${encounter}` },
      onsetDateTime: date(admitted - 2 * DAY),
      abatementDateTime: date(discharged + 10 * DAY),
      recordedDate: date(admitted),
    },
    {
      resourceType: "DocumentReference",
      id: `syn-documentreference-${short}-scn-discharge`,
      meta: tag,
      status: "current",
      type: { coding: [{ system: LOINC, code: "18842-5", display: "Discharge summary" }] },
      category: [
        {
          coding: [
            {
              system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
              code: "clinical-note",
              display: "Clinical Note",
            },
          ],
        },
      ],
      subject,
      date: iso(discharged),
      author: [{ reference: "Practitioner/syn-practitioner-1" }],
      content: [
        {
          attachment: {
            contentType: "text/plain",
            data: Buffer.from(summary).toString("base64"),
            title: "Discharge summary",
          },
        },
      ],
      context: {
        encounter: [{ reference: `Encounter/${encounter}` }],
        period: { start: iso(admitted), end: iso(discharged) },
      },
    },
  ];
}

function trialAdverseEvent(pid: string, short: string, reference: number): FhirResource[] {
  const subject = { reference: `Patient/${pid}` };
  const study = "syn-researchstudy-emu-101";
  return [
    {
      resourceType: "ResearchStudy",
      id: study,
      meta: tag,
      identifier: [{ system: "urn:emuhealth:synthetic:study", value: "EMU-101" }],
      title: "EMU-101: synthetic phase 2 oncology study",
      status: "active",
    },
    {
      resourceType: "ResearchSubject",
      id: `syn-researchsubject-${short}-emu-101`,
      meta: tag,
      status: "on-study",
      study: { reference: `ResearchStudy/${study}` },
      individual: subject,
      period: { start: date(reference - 120 * DAY) },
    },
    {
      resourceType: "AdverseEvent",
      id: `syn-adverseevent-${short}-scn-syncope`,
      meta: tag,
      actuality: "actual",
      category: [
        {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/adverse-event-category", code: "medical-mishap" }],
        },
      ],
      event: { coding: [{ system: ICD10, code: "R55", display: "Syncope and collapse" }], text: "Syncope" },
      subject,
      date: iso(reference - 60 * DAY),
      seriousness: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/adverse-event-seriousness",
            code: "serious",
            display: "Serious",
          },
        ],
      },
      study: [{ reference: `ResearchStudy/${study}` }],
    },
  ];
}

/** Records the requested scenarios add, given the records generated so far. */
export function scenarioRecords(
  requests: Array<{ name: ScenarioName; patientId: string }>,
  records: FhirResource[],
  reference: number,
): FhirResource[] {
  const out: FhirResource[] = [];
  let study = false;
  for (const { name, patientId } of requests) {
    const short = patientId.slice(12);
    if (name === "diabetes-cgm") {
      const has = new Set(
        records
          .filter(
            (r) =>
              r.resourceType === "Condition" &&
              (r.subject as { reference?: string })?.reference === `Patient/${patientId}`,
          )
          .flatMap((r) => ((r.code as { coding?: Array<{ code: string }> })?.coding ?? []).map((c) => c.code)),
      );
      out.push(...diabetesCgm(patientId, short, reference, has));
    } else if (name === "inpatient-stay") out.push(...inpatientStay(patientId, short, reference));
    else {
      // One ResearchStudy however many patients enroll.
      out.push(
        ...trialAdverseEvent(patientId, short, reference).filter((r) => r.resourceType !== "ResearchStudy" || !study),
      );
      study = true;
    }
  }
  return out;
}
