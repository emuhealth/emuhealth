import type { FhirResource } from "./store.js";

/**
 * Deterministic, Synthea-style synthetic patient records (decision 0009).
 * Every resource is tagged synthetic. Names are common first and last names combined at random,
 * identifiers use an emuhealth system, and phone numbers use the 555-01xx range reserved for fiction.
 */
export interface GenerateOptions {
  /** Number of patients, 0 to 1000. Default 5. */
  patients?: number;
  /** PRNG seed; the same seed always produces the same records. Default 1. */
  seed?: number;
  /** Date the records are relative to (YYYY-MM-DD): ages, encounter dates, and onsets. Default 2026-01-01. */
  referenceDate?: string;
}

export const DEFAULT_GENERATE_OPTIONS: Required<GenerateOptions> = {
  patients: 5,
  seed: 1,
  referenceDate: "2026-01-01",
};

export const SYNTHETIC_TAG = { system: "urn:emuhealth:tag", code: "synthetic", display: "Synthetic data" };

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
const CVX = "http://hl7.org/fhir/sid/cvx";
const OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
const CONDITION_VERIFICATION = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const CONDITION_CATEGORY = "http://terminology.hl7.org/CodeSystem/condition-category";
const ALLERGY_CLINICAL = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";
const ALLERGY_VERIFICATION = "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";
const MRN_SYSTEM = "urn:emuhealth:synthetic:mrn";

const GIVEN = {
  female: ["Olivia", "Emma", "Ava", "Sophia", "Mia", "Amelia", "Harper", "Ella", "Grace", "Nora", "Maya", "Zoe"],
  male: ["Liam", "Noah", "Elijah", "James", "Lucas", "Henry", "Mateo", "Ezra", "Leo", "Owen", "Caleb", "Isaac"],
};
const FAMILY = [
  "Garcia",
  "Nguyen",
  "Patel",
  "Johnson",
  "Kim",
  "Okafor",
  "Rossi",
  "Cohen",
  "Silva",
  "Murphy",
  "Haddad",
  "Novak",
  "Tanaka",
  "Lopez",
  "Fischer",
  "Brown",
];
const STREETS = ["Maple", "Oak", "Cedar", "Willow", "Birch", "Elm", "Pine", "Aspen"];
const CITIES = [
  { city: "Springfield", state: "IL" },
  { city: "Riverton", state: "WY" },
  { city: "Fairview", state: "OR" },
  { city: "Lakeside", state: "CA" },
  { city: "Greenville", state: "SC" },
];

interface ConditionDef {
  code: string;
  display: string;
  medication?: { code: string; display: string; dosage: string };
  lab?: "a1c" | "cholesterol";
}

// ICD-10-CM conditions and the RxNorm medication commonly ordered for them.
const CONDITIONS: ConditionDef[] = [
  {
    code: "I10",
    display: "Essential (primary) hypertension",
    medication: { code: "314076", display: "lisinopril 10 MG Oral Tablet", dosage: "1 tablet by mouth once daily" },
  },
  {
    code: "E11.9",
    display: "Type 2 diabetes mellitus without complications",
    medication: {
      code: "861007",
      display: "metformin hydrochloride 500 MG Oral Tablet",
      dosage: "1 tablet by mouth twice daily with meals",
    },
    lab: "a1c",
  },
  {
    code: "E78.5",
    display: "Hyperlipidemia, unspecified",
    medication: { code: "617310", display: "atorvastatin 20 MG Oral Tablet", dosage: "1 tablet by mouth at bedtime" },
    lab: "cholesterol",
  },
  {
    code: "J45.909",
    display: "Unspecified asthma, uncomplicated",
    medication: {
      code: "2123111",
      display: "NDA020503 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler",
      dosage: "2 puffs every 4 to 6 hours as needed",
    },
  },
  {
    code: "K21.9",
    display: "Gastro-esophageal reflux disease without esophagitis",
    medication: {
      code: "198051",
      display: "omeprazole 20 MG Delayed Release Oral Capsule",
      dosage: "1 capsule by mouth once daily before breakfast",
    },
  },
  {
    code: "F41.1",
    display: "Generalized anxiety disorder",
    medication: { code: "312941", display: "sertraline 50 MG Oral Tablet", dosage: "1 tablet by mouth once daily" },
  },
  { code: "E66.9", display: "Obesity, unspecified" },
];

const ALLERGIES = [
  { coding: [{ system: RXNORM, code: "7980", display: "penicillin G" }], text: "Penicillin", category: "medication" },
  { coding: [{ system: RXNORM, code: "723", display: "amoxicillin" }], text: "Amoxicillin", category: "medication" },
  { text: "Peanut", category: "food" },
  { text: "Shellfish", category: "food" },
];

const VACCINES = [
  { code: "140", display: "Influenza, seasonal, injectable, preservative free" },
  { code: "208", display: "COVID-19, mRNA, LNP-S, PF, 30 mcg/0.3 mL dose" },
  { code: "115", display: "Tdap" },
  { code: "33", display: "pneumococcal polysaccharide vaccine, 23 valent" },
];

// LOINC codes for the vital signs and labs above, and the UCUM units their values use.
const LOINC_CODES = [
  { code: "8867-4", display: "Heart rate" },
  { code: "9279-1", display: "Respiratory rate" },
  { code: "8310-5", display: "Body temperature" },
  { code: "2708-6", display: "Oxygen saturation in Arterial blood" },
  { code: "59408-5", display: "Oxygen saturation in Arterial blood by Pulse oximetry" },
  { code: "85354-9", display: "Blood pressure panel with all children optional" },
  { code: "8480-6", display: "Systolic blood pressure" },
  { code: "8462-4", display: "Diastolic blood pressure" },
  { code: "8302-2", display: "Body height" },
  { code: "29463-7", display: "Body weight" },
  { code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  { code: "2093-3", display: "Cholesterol [Mass/volume] in Serum or Plasma" },
];
const UCUM_CODES = [
  { code: "/min", display: "per minute" },
  { code: "Cel", display: "degree Celsius" },
  { code: "%", display: "percent" },
  { code: "mm[Hg]", display: "millimeter of mercury" },
  { code: "cm", display: "centimeter" },
  { code: "kg", display: "kilogram" },
  { code: "mg/dL", display: "milligram per deciliter" },
];

export interface TerminologySubset {
  system: string;
  name: string;
  title: string;
  concepts: Array<{ code: string; display: string }>;
}

/** Every code the generator uses, grouped by code system. The terminology fixtures are built from this. */
export function generatorTerminology(): TerminologySubset[] {
  const rxnorm = new Map<string, string>();
  for (const c of CONDITIONS) if (c.medication) rxnorm.set(c.medication.code, c.medication.display);
  for (const a of ALLERGIES) for (const coding of a.coding ?? []) rxnorm.set(coding.code, coding.display);
  return [
    {
      system: ICD10,
      name: "ICD10CMSubset",
      title: "ICD-10-CM (emuhealth subset)",
      concepts: CONDITIONS.map(({ code, display }) => ({ code, display })),
    },
    {
      system: RXNORM,
      name: "RxNormSubset",
      title: "RxNorm (emuhealth subset)",
      concepts: [...rxnorm].map(([code, display]) => ({ code, display })),
    },
    { system: CVX, name: "CVXSubset", title: "CVX (emuhealth subset)", concepts: VACCINES },
    { system: LOINC, name: "LOINCSubset", title: "LOINC (emuhealth subset)", concepts: LOINC_CODES },
    { system: UCUM, name: "UCUMSubset", title: "UCUM (emuhealth subset)", concepts: UCUM_CODES },
  ];
}

/** mulberry32: small, fast, deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** n distinct items, in list order. */
  sample<T>(items: readonly T[], n: number): T[] {
    const indexes = new Set<number>();
    while (indexes.size < Math.min(n, items.length)) indexes.add(Math.floor(this.next() * items.length));
    return [...indexes].sort((a, b) => a - b).map((i) => items[i]);
  }
}

const DAY = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isoDateTime = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const round = (value: number, digits = 0) => Number(value.toFixed(digits));
const tagged = (resource: FhirResource): FhirResource => ({ ...resource, meta: { tag: [SYNTHETIC_TAG] } });
const loinc = (code: string, display: string) => ({ coding: [{ system: LOINC, code, display }], text: display });
const quantity = (value: number, unit: string, code = unit) => ({ value, unit, system: UCUM, code });

function category(code: "vital-signs" | "laboratory") {
  const display = code === "vital-signs" ? "Vital Signs" : "Laboratory";
  return [{ coding: [{ system: OBS_CATEGORY, code, display }], text: display }];
}

/** Generate a synthetic population. Output is a pure function of the options. */
export function generateSyntheticRecords(options: GenerateOptions = {}): FhirResource[] {
  const { patients, seed, referenceDate } = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  if (!Number.isInteger(patients) || patients < 0 || patients > 1000)
    throw new Error("fhir.generate.patients must be an integer from 0 to 1000");
  if (!Number.isInteger(seed)) throw new Error("fhir.generate.seed must be an integer");
  const reference = Date.parse(`${referenceDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) || Number.isNaN(reference))
    throw new Error("fhir.generate.referenceDate must be a date in YYYY-MM-DD form");

  const rng = new Random(seed);
  const out: FhirResource[] = [];
  const organization = "Organization/syn-organization-1";
  out.push(
    tagged({
      resourceType: "Organization",
      id: "syn-organization-1",
      active: true,
      name: "Synthetic Health Clinic",
      telecom: [{ system: "phone", value: "555-0100", use: "work" }],
    }),
  );
  const practitioners = [1, 2].map((n) => {
    const gender = rng.pick(["female", "male"] as const);
    out.push(
      tagged({
        resourceType: "Practitioner",
        id: `syn-practitioner-${n}`,
        active: true,
        identifier: [{ system: "urn:emuhealth:synthetic:practitioner", value: `SYN-PR-${n}` }],
        name: [{ family: rng.pick(FAMILY), given: [rng.pick(GIVEN[gender])], prefix: ["Dr."] }],
        gender,
      }),
    );
    return `Practitioner/syn-practitioner-${n}`;
  });

  for (let n = 1; n <= patients; n++) {
    const pid = `syn-patient-${String(n).padStart(3, "0")}`;
    const subject = { reference: `Patient/${pid}` };
    const gender = rng.pick(["female", "male"] as const);
    const age = rng.int(18, 85);
    const birth = reference - age * 365.25 * DAY - rng.int(0, 364) * DAY;
    const place = rng.pick(CITIES);
    const practitioner = rng.pick(practitioners);
    out.push(
      tagged({
        resourceType: "Patient",
        id: pid,
        active: true,
        identifier: [
          {
            use: "usual",
            type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }], text: "MRN" },
            system: MRN_SYSTEM,
            value: `SYN-${String(n).padStart(6, "0")}`,
          },
        ],
        name: [{ use: "official", family: rng.pick(FAMILY), given: [rng.pick(GIVEN[gender])] }],
        telecom: [{ system: "phone", value: `555-01${String(rng.int(0, 99)).padStart(2, "0")}`, use: "home" }],
        gender,
        birthDate: isoDate(birth),
        address: [
          {
            use: "home",
            line: [`${rng.int(10, 999)} ${rng.pick(STREETS)} St`],
            city: place.city,
            state: place.state,
            postalCode: String(rng.int(10000, 99999)),
            country: "US",
          },
        ],
        generalPractitioner: [{ reference: practitioner }],
        managingOrganization: { reference: organization },
      }),
    );

    const conditions = rng.sample(CONDITIONS, rng.int(0, 3));
    const obese = conditions.some((c) => c.code === "E66.9");
    for (const [i, condition] of conditions.entries()) {
      const onset = reference - rng.int(180, 3650) * DAY;
      out.push(
        tagged({
          resourceType: "Condition",
          id: `syn-condition-${pid.slice(12)}-${i + 1}`,
          clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
          verificationStatus: { coding: [{ system: CONDITION_VERIFICATION, code: "confirmed" }] },
          category: [
            { coding: [{ system: CONDITION_CATEGORY, code: "problem-list-item", display: "Problem List Item" }] },
          ],
          code: {
            coding: [{ system: ICD10, code: condition.code, display: condition.display }],
            text: condition.display,
          },
          subject,
          onsetDateTime: isoDate(onset),
          recordedDate: isoDate(onset),
        }),
      );
      if (condition.medication) {
        out.push(
          tagged({
            resourceType: "MedicationRequest",
            id: `syn-medicationrequest-${pid.slice(12)}-${i + 1}`,
            status: "active",
            intent: "order",
            medicationCodeableConcept: {
              coding: [{ system: RXNORM, code: condition.medication.code, display: condition.medication.display }],
              text: condition.medication.display,
            },
            subject,
            authoredOn: isoDate(onset + rng.int(0, 30) * DAY),
            requester: { reference: practitioner },
            reasonReference: [{ reference: `Condition/syn-condition-${pid.slice(12)}-${i + 1}` }],
            dosageInstruction: [{ text: condition.medication.dosage }],
          }),
        );
      }
    }

    const encounterCount = rng.int(1, 3);
    const height = gender === "female" ? rng.float(152, 175) : rng.float(165, 190);
    const bmi = obese ? rng.float(31, 38) : rng.float(19, 29);
    for (let e = 1; e <= encounterCount; e++) {
      const eid = `syn-encounter-${pid.slice(12)}-${e}`;
      const start = reference - rng.int(7, 1095) * DAY + rng.int(8, 16) * 3_600_000;
      const encounter = { reference: `Encounter/${eid}` };
      out.push(
        tagged({
          resourceType: "Encounter",
          id: eid,
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
          type: [{ text: "Office visit" }],
          subject,
          participant: [{ individual: { reference: practitioner } }],
          period: { start: isoDateTime(start), end: isoDateTime(start + 30 * 60_000) },
          serviceProvider: { reference: organization },
        }),
      );
      const effectiveDateTime = isoDateTime(start + 5 * 60_000);
      const vital = (key: string, code: FhirResource["code"], value: Record<string, unknown>) =>
        out.push(
          tagged({
            resourceType: "Observation",
            id: `syn-observation-${pid.slice(12)}-${e}-${key}`,
            status: "final",
            category: category("vital-signs"),
            code,
            subject,
            encounter,
            effectiveDateTime,
            ...value,
          }),
        );
      const hasHypertension = conditions.some((c) => c.code === "I10");
      vital("hr", loinc("8867-4", "Heart rate"), { valueQuantity: quantity(rng.int(58, 96), "/min") });
      vital("rr", loinc("9279-1", "Respiratory rate"), { valueQuantity: quantity(rng.int(12, 20), "/min") });
      vital("temp", loinc("8310-5", "Body temperature"), {
        valueQuantity: quantity(round(rng.float(36.3, 37.4), 1), "Cel"),
      });
      vital(
        "spo2",
        {
          coding: [
            { system: LOINC, code: "2708-6", display: "Oxygen saturation in Arterial blood" },
            { system: LOINC, code: "59408-5", display: "Oxygen saturation in Arterial blood by Pulse oximetry" },
          ],
          text: "Oxygen saturation",
        },
        { valueQuantity: quantity(rng.int(94, 100), "%") },
      );
      vital("bp", loinc("85354-9", "Blood pressure panel with all children optional"), {
        component: [
          {
            code: loinc("8480-6", "Systolic blood pressure"),
            valueQuantity: quantity(hasHypertension ? rng.int(135, 160) : rng.int(105, 132), "mm[Hg]"),
          },
          {
            code: loinc("8462-4", "Diastolic blood pressure"),
            valueQuantity: quantity(hasHypertension ? rng.int(85, 100) : rng.int(65, 84), "mm[Hg]"),
          },
        ],
      });
      vital("height", loinc("8302-2", "Body height"), { valueQuantity: quantity(round(height, 1), "cm") });
      vital("weight", loinc("29463-7", "Body weight"), {
        valueQuantity: quantity(round(bmi * (height / 100) ** 2, 1), "kg"),
      });
      for (const condition of conditions.filter((c) => c.lab)) {
        const a1c = condition.lab === "a1c";
        out.push(
          tagged({
            resourceType: "Observation",
            id: `syn-observation-${pid.slice(12)}-${e}-${condition.lab}`,
            status: "final",
            category: category("laboratory"),
            code: a1c
              ? loinc("4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood")
              : loinc("2093-3", "Cholesterol [Mass/volume] in Serum or Plasma"),
            subject,
            encounter,
            effectiveDateTime,
            valueQuantity: a1c ? quantity(round(rng.float(6.5, 9.5), 1), "%") : quantity(rng.int(200, 280), "mg/dL"),
          }),
        );
      }
    }

    if (rng.chance(0.3)) {
      const allergy = rng.pick(ALLERGIES);
      out.push(
        tagged({
          resourceType: "AllergyIntolerance",
          id: `syn-allergyintolerance-${pid.slice(12)}-1`,
          clinicalStatus: { coding: [{ system: ALLERGY_CLINICAL, code: "active" }] },
          verificationStatus: { coding: [{ system: ALLERGY_VERIFICATION, code: "confirmed" }] },
          category: [allergy.category],
          criticality: rng.pick(["low", "high"]),
          code: allergy.coding ? { coding: allergy.coding, text: allergy.text } : { text: allergy.text },
          patient: subject,
          recordedDate: isoDate(reference - rng.int(365, 3650) * DAY),
        }),
      );
    }

    for (const [v, vaccine] of rng.sample(VACCINES, rng.int(1, 3)).entries()) {
      out.push(
        tagged({
          resourceType: "Immunization",
          id: `syn-immunization-${pid.slice(12)}-${v + 1}`,
          status: "completed",
          vaccineCode: {
            coding: [{ system: CVX, code: vaccine.code, display: vaccine.display }],
            text: vaccine.display,
          },
          patient: subject,
          occurrenceDateTime: isoDate(reference - rng.int(30, 1825) * DAY),
          primarySource: true,
        }),
      );
    }
  }
  return out;
}
