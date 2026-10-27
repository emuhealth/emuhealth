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
const ICD10PCS = "http://www.cms.gov/Medicare/Coding/ICD10";
const CDC_RACE_ETHNICITY = "urn:oid:2.16.840.1.113883.6.238";
const NPI = "http://hl7.org/fhir/sid/us-npi";
const DATA_ABSENT = "http://terminology.hl7.org/CodeSystem/data-absent-reason";
const DATA_ABSENT_EXTENSION = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const US_CORE = "http://hl7.org/fhir/us/core/StructureDefinition";
const ENCOUNTER_SYSTEM = "urn:emuhealth:synthetic:encounter";
const DOCUMENT_SYSTEM = "urn:emuhealth:synthetic:document";

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
  { code: "140", display: "Influenza, split virus, trivalent, PF" },
  { code: "208", display: "COVID-19, mRNA, LNP-S, PF, 30 mcg/0.3 mL dose" },
  { code: "115", display: "Tdap" },
  { code: "33", display: "pneumococcal polysaccharide vaccine, 23 valent" },
];

// ICD-10-PCS procedure codes (public domain, published by CMS).
const PROCEDURES = [
  { code: "4A02X4Z", display: "Measurement of Cardiac Electrical Activity, External Approach" },
  { code: "BW03ZZZ", display: "Plain Radiography of Chest" },
  { code: "3E0234Z", display: "Introduction of Serum, Toxoid and Vaccine into Muscle, Percutaneous Approach" },
];

// OMB race and ethnicity categories from the CDC Race and Ethnicity code system (public domain).
const RACES = [
  { code: "2106-3", display: "White" },
  { code: "2054-5", display: "Black or African American" },
  { code: "2028-9", display: "Asian" },
  { code: "1002-5", display: "American Indian or Alaska Native" },
  { code: "2076-8", display: "Native Hawaiian or Other Pacific Islander" },
];
const ETHNICITIES = [
  { code: "2135-2", display: "Hispanic or Latino" },
  { code: "2186-5", display: "Not Hispanic or Latino" },
];

// Smoking status values are SNOMED CT in US Core, which emuhealth does not bundle (decision 0011), so the
// generator records them as text only.
const SMOKING_STATUS = ["Never smoked tobacco", "Former smoker", "Current every day smoker"];

// LOINC clinical note types and report categories, which US Core expects a server to support.
const NOTE_TYPES = [
  { code: "11506-3", display: "Progress note" },
  { code: "11488-4", display: "Consult note" },
  { code: "18842-5", display: "Discharge summary" },
  { code: "34117-2", display: "History and physical note" },
  { code: "28570-0", display: "Procedure note" },
];
const NOTE_CATEGORIES = [
  { code: "LP29708-2", display: "Cardiology" },
  { code: "LP7839-6", display: "Pathology" },
  { code: "LP29684-5", display: "Radiology" },
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
  { code: "3151-8", display: "Inhaled oxygen flow rate" },
  { code: "3150-0", display: "Inhaled oxygen concentration" },
  { code: "72166-2", display: "Tobacco smoking status" },
  { code: "77606-2", display: "Weight-for-length Per age and sex" },
  { code: "59576-9", display: "Body mass index (BMI) [Percentile] Per age and sex" },
  { code: "8289-1", display: "Head Occipital-frontal circumference Percentile" },
  ...NOTE_TYPES,
  ...NOTE_CATEGORIES,
];
const UCUM_CODES = [
  { code: "/min", display: "per minute" },
  { code: "Cel", display: "degree Celsius" },
  { code: "%", display: "percent" },
  { code: "mm[Hg]", display: "millimeter of mercury" },
  { code: "cm", display: "centimeter" },
  { code: "kg", display: "kilogram" },
  { code: "mg/dL", display: "milligram per deciliter" },
  { code: "L/min", display: "liter per minute" },
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
    { system: ICD10PCS, name: "ICD10PCSSubset", title: "ICD-10-PCS (emuhealth subset)", concepts: PROCEDURES },
    {
      system: CDC_RACE_ETHNICITY,
      name: "CDCRaceEthnicitySubset",
      title: "CDC Race and Ethnicity (emuhealth subset)",
      concepts: [...RACES, ...ETHNICITIES],
    },
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

const absent = (code: string) => ({ extension: [{ url: DATA_ABSENT_EXTENSION, valueCode: code }] });
/**
 * A concept whose code would come from SNOMED CT or CPT, which emuhealth does not bundle (decision 0011).
 * US Core says to use the "unknown" data absent reason code, with the meaning in text.
 */
const uncoded = (text: string) => ({ coding: [{ system: DATA_ABSENT, code: "unknown", display: "Unknown" }], text });
const narrative = (text: string) => ({
  status: "generated",
  div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${text}</p></div>`,
});
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * A synthetic NPI. It has a valid check digit, but starts with 0, and real NPIs start with 1 or 2,
 * so it can never belong to a real provider.
 */
function syntheticNpi(serial: number): string {
  const body = `0${String(serial).padStart(8, "0")}`;
  // Luhn over the 80840 prefix plus the first nine digits, as the NPI standard defines.
  const digits = `80840${body}`.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function category(code: "vital-signs" | "laboratory" | "social-history") {
  if (code === "social-history")
    return [{ coding: [{ system: OBS_CATEGORY, code, display: "Social History" }], text: "Social History" }];
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
  // US Core content added later draws from its own stream, so the records above keep their values for a seed.
  const extra = new Random(seed ^ 0x5eed);
  const out: FhirResource[] = [];
  const organization = "Organization/syn-organization-1";
  const location = "Location/syn-location-1";
  const clinicAddress = {
    use: "work",
    line: ["100 Main St"],
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    country: "US",
  };
  out.push(
    tagged({
      resourceType: "Organization",
      id: "syn-organization-1",
      identifier: [{ system: NPI, value: syntheticNpi(1) }],
      active: true,
      name: "Synthetic Health Clinic",
      telecom: [{ system: "phone", value: "555-0100", use: "work" }],
      address: [clinicAddress],
    }),
    tagged({
      resourceType: "Location",
      id: "syn-location-1",
      status: "active",
      name: "Synthetic Health Clinic, Main Street",
      telecom: [{ system: "phone", value: "555-0100", use: "work" }],
      address: clinicAddress,
      managingOrganization: { reference: organization },
    }),
    tagged({
      resourceType: "Endpoint",
      id: "syn-endpoint-1",
      status: "active",
      connectionType: {
        system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
        code: "hl7-fhir-rest",
      },
      name: "Synthetic Health Clinic FHIR endpoint",
      payloadType: [{ text: "FHIR R4 resources" }],
      address: "http://localhost:4100",
    }),
  );
  const practitioners = [1, 2].map((n) => {
    const gender = rng.pick(["female", "male"] as const);
    out.push(
      tagged({
        resourceType: "Practitioner",
        id: `syn-practitioner-${n}`,
        active: true,
        identifier: [
          { system: "urn:emuhealth:synthetic:practitioner", value: `SYN-PR-${n}` },
          { system: NPI, value: syntheticNpi(100 + n) },
        ],
        name: [{ family: rng.pick(FAMILY), given: [rng.pick(GIVEN[gender])], prefix: ["Dr."] }],
        gender,
      }),
      tagged({
        resourceType: "PractitionerRole",
        id: `syn-practitionerrole-${n}`,
        active: true,
        practitioner: { reference: `Practitioner/syn-practitioner-${n}` },
        organization: { reference: organization },
        // Text only: the US Core bindings here use the NUCC taxonomy, which emuhealth does not bundle.
        code: [{ text: "Physician" }],
        specialty: [{ text: "Family Medicine" }],
        location: [{ reference: location }],
        telecom: [{ system: "phone", value: `555-010${n}`, use: "work" }],
        endpoint: [{ reference: "Endpoint/syn-endpoint-1" }],
      }),
    );
    return `Practitioner/syn-practitioner-${n}`;
  });

  for (let n = 1; n <= patients; n++) {
    const pid = `syn-patient-${String(n).padStart(3, "0")}`;
    const subject = { reference: `Patient/${pid}` };
    const gender = rng.pick(["female", "male"] as const);
    const age = rng.int(18, 85);
    const adultBirth = reference - age * 365.25 * DAY - rng.int(0, 364) * DAY;
    // Every fifth patient, starting with the fourth, is a two-year-old, so the pediatric profiles have data.
    const pediatric = n % 5 === 4;
    const birth = pediatric ? reference - 2 * 365.25 * DAY - extra.int(0, 60) * DAY : adultBirth;
    const place = rng.pick(CITIES);
    const practitioner = rng.pick(practitioners);
    const first = out.length;
    const race = extra.pick(RACES);
    const ethnicity = extra.pick(ETHNICITIES);
    const previousFamily = extra.pick(FAMILY);
    const movedOut = reference - extra.int(400, 3000) * DAY;
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
    const patient = out[out.length - 1];
    patient.extension = [
      {
        url: `${US_CORE}/us-core-race`,
        extension: [
          { url: "ombCategory", valueCoding: { system: CDC_RACE_ETHNICITY, ...race } },
          { url: "text", valueString: race.display },
        ],
      },
      {
        url: `${US_CORE}/us-core-ethnicity`,
        extension: [
          { url: "ombCategory", valueCoding: { system: CDC_RACE_ETHNICITY, ...ethnicity } },
          { url: "text", valueString: ethnicity.display },
        ],
      },
      { url: `${US_CORE}/us-core-birthsex`, valueCode: gender === "female" ? "F" : "M" },
    ];
    if (n % 2 === 0 && !pediatric)
      (patient.name as unknown[]).push({
        use: "old",
        family: previousFamily,
        given: (patient.name as Array<{ given: string[] }>)[0].given,
        period: { end: isoDate(movedOut) },
      });
    (patient.address as unknown[]).push({
      use: "old",
      line: [`${extra.int(10, 999)} ${extra.pick(STREETS)} Ave`],
      city: place.city,
      state: place.state,
      postalCode: String(extra.int(10000, 99999)),
      country: "US",
      period: { end: isoDate(movedOut) },
    });
    const spanish = ethnicity.code === "2135-2" && extra.chance(0.5);
    patient.communication = [
      {
        language: {
          coding: [
            {
              system: "urn:ietf:bcp:47",
              code: spanish ? "es" : "en-US",
              display: spanish ? "Spanish" : "English (United States)",
            },
          ],
        },
      },
    ];
    const short = pid.slice(12);

    const sampled = rng.sample(CONDITIONS, rng.int(0, 3));
    const conditions = pediatric ? sampled.filter((c) => c.code === "J45.909") : sampled;
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
            encounter: { reference: `Encounter/syn-encounter-${short}-1` },
            authoredOn: isoDate(onset + rng.int(0, 30) * DAY),
            reportedBoolean: false,
            requester: { reference: practitioner },
            reasonReference: [{ reference: `Condition/syn-condition-${pid.slice(12)}-${i + 1}` }],
            dosageInstruction: [{ text: condition.medication.dosage }],
          }),
        );
      }
    }

    const encounterCount = rng.int(1, 3);
    const adultHeight = gender === "female" ? rng.float(152, 175) : rng.float(165, 190);
    const height = pediatric ? extra.float(82, 92) : adultHeight;
    const bmi = pediatric ? extra.float(15, 17.5) : obese ? rng.float(31, 38) : rng.float(19, 29);
    const reason = conditions[0]
      ? {
          coding: [{ system: ICD10, code: conditions[0].code, display: conditions[0].display }],
          text: conditions[0].display,
        }
      : { text: "General examination" };
    const encounterStarts: number[] = [];
    const labResults: Array<{ encounter: number; ids: string[]; code: string; display: string; at: number }> = [];
    for (let e = 1; e <= encounterCount; e++) {
      const eid = `syn-encounter-${pid.slice(12)}-${e}`;
      const start = reference - rng.int(7, 1095) * DAY + rng.int(8, 16) * 3_600_000;
      const encounter = { reference: `Encounter/${eid}` };
      encounterStarts.push(start);
      const period = { start: isoDateTime(start), end: isoDateTime(start + 30 * 60_000) };
      out.push(
        tagged({
          resourceType: "Encounter",
          id: eid,
          identifier: [{ system: ENCOUNTER_SYSTEM, value: `SYN-ENC-${short}-${e}` }],
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
          type: [uncoded("Office visit")],
          subject,
          participant: [
            {
              type: [
                {
                  coding: [
                    {
                      system: "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
                      code: "PPRF",
                      display: "primary performer",
                    },
                  ],
                },
              ],
              period,
              individual: { reference: practitioner },
            },
          ],
          period,
          reasonCode: [reason],
          hospitalization: {
            dischargeDisposition: {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/discharge-disposition",
                  code: "home",
                  display: "Home",
                },
              ],
            },
          },
          location: [{ location: { reference: location } }],
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
      // Two-year-olds breathe and beat faster than adults.
      vital("hr", loinc("8867-4", "Heart rate"), {
        valueQuantity: quantity(rng.int(58, 96) + (pediatric ? 30 : 0), "/min"),
      });
      vital("rr", loinc("9279-1", "Respiratory rate"), {
        valueQuantity: quantity(rng.int(12, 20) + (pediatric ? 10 : 0), "/min"),
      });
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
        {
          valueQuantity: quantity(rng.int(94, 100), "%"),
          // Room air: no supplemental oxygen.
          component: [
            { code: loinc("3151-8", "Inhaled oxygen flow rate"), valueQuantity: quantity(0, "L/min") },
            { code: loinc("3150-0", "Inhaled oxygen concentration"), valueQuantity: quantity(21, "%") },
          ],
        },
      );
      const systolic = hasHypertension ? rng.int(135, 160) : rng.int(105, 132);
      const diastolic = hasHypertension ? rng.int(85, 100) : rng.int(65, 84);
      // Blood pressure is usually not taken at a two-year-old's visit, which the record says with a data absent reason.
      const notPerformed = { coding: [{ system: DATA_ABSENT, code: "not-performed", display: "Not Performed" }] };
      vital("bp", loinc("85354-9", "Blood pressure panel with all children optional"), {
        component: [
          {
            code: loinc("8480-6", "Systolic blood pressure"),
            ...(pediatric ? { dataAbsentReason: notPerformed } : { valueQuantity: quantity(systolic, "mm[Hg]") }),
          },
          {
            code: loinc("8462-4", "Diastolic blood pressure"),
            ...(pediatric ? { dataAbsentReason: notPerformed } : { valueQuantity: quantity(diastolic, "mm[Hg]") }),
          },
        ],
      });
      vital("height", loinc("8302-2", "Body height"), { valueQuantity: quantity(round(height, 1), "cm") });
      vital("weight", loinc("29463-7", "Body weight"), {
        valueQuantity: quantity(round(bmi * (height / 100) ** 2, 1), "kg"),
      });
      if (pediatric) {
        vital("wfl", loinc("77606-2", "Weight-for-length Per age and sex"), {
          valueQuantity: quantity(extra.int(20, 80), "%"),
        });
        vital("bmip", loinc("59576-9", "Body mass index (BMI) [Percentile] Per age and sex"), {
          valueQuantity: quantity(extra.int(20, 80), "%"),
        });
        vital("hc", loinc("8289-1", "Head Occipital-frontal circumference Percentile"), {
          valueQuantity: quantity(extra.int(20, 80), "%"),
        });
      }
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
      const labs = conditions.filter((c) => c.lab);
      if (labs.length > 0)
        labResults.push({
          encounter: e,
          ids: labs.map((c) => `Observation/syn-observation-${short}-${e}-${c.lab}`),
          code: labs[0].lab === "a1c" ? "4548-4" : "2093-3",
          display:
            labs[0].lab === "a1c"
              ? "Hemoglobin A1c/Hemoglobin.total in Blood"
              : "Cholesterol [Mass/volume] in Serum or Plasma",
          at: start,
        });
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
          code: allergy.coding ? { coding: allergy.coding, text: allergy.text } : uncoded(allergy.text),
          patient: subject,
          recordedDate: isoDate(reference - rng.int(365, 3650) * DAY),
          reaction: [{ manifestation: [{ text: allergy.category === "food" ? "Hives" : "Skin rash" }] }],
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

    usCoreRecords(out, extra, {
      n,
      short,
      subject,
      practitioner,
      organization,
      pediatric,
      reference,
      encounterStarts,
      labResults,
    });
    out.push(provenance(out.slice(first), short, practitioner, organization, encounterStarts));
  }
  return out;
}

interface PatientContext {
  n: number;
  short: string;
  subject: { reference: string };
  practitioner: string;
  organization: string;
  pediatric: boolean;
  reference: number;
  encounterStarts: number[];
  labResults: Array<{ encounter: number; ids: string[]; code: string; display: string; at: number }>;
}

/** The rest of a patient's US Core record: smoking status, procedures, care planning, notes, reports, and devices. */
function usCoreRecords(out: FhirResource[], rng: Random, ctx: PatientContext): void {
  const { n, short, subject, practitioner, organization, pediatric, reference, encounterStarts } = ctx;
  const push = (resource: FhirResource) => out.push(tagged(resource));
  const lastVisit = Math.max(...encounterStarts);
  const encounter = (e: number) => ({ reference: `Encounter/syn-encounter-${short}-${e}` });
  const visit = encounterStarts.indexOf(lastVisit) + 1;

  push({
    resourceType: "Observation",
    id: `syn-observation-${short}-smoking`,
    status: "final",
    category: category("social-history"),
    code: loinc("72166-2", "Tobacco smoking status"),
    subject,
    effectiveDateTime: isoDateTime(lastVisit),
    issued: isoDateTime(lastVisit + 3_600_000),
    valueCodeableConcept: { text: pediatric ? SMOKING_STATUS[0] : rng.pick(SMOKING_STATUS) },
  });

  for (const lab of ctx.labResults) {
    push({
      resourceType: "DiagnosticReport",
      id: `syn-diagnosticreport-${short}-${lab.encounter}-lab`,
      status: "final",
      category: [
        {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB", display: "Laboratory" }],
        },
      ],
      code: loinc(lab.code, lab.display),
      subject,
      encounter: encounter(lab.encounter),
      effectiveDateTime: isoDateTime(lab.at + 5 * 60_000),
      issued: isoDateTime(lab.at + DAY),
      performer: [{ reference: organization }],
      result: lab.ids.map((id) => ({ reference: id })),
    });
  }

  const noteText = `Synthetic progress note for ${subject.reference}. Patient seen for a routine visit. No real patient data.`;
  push({
    resourceType: "DiagnosticReport",
    id: `syn-diagnosticreport-${short}-note`,
    status: "final",
    category: [{ coding: [{ system: LOINC, ...NOTE_CATEGORIES[(n - 1) % NOTE_CATEGORIES.length] }] }],
    code: loinc("11506-3", "Progress note"),
    subject,
    encounter: encounter(visit),
    effectiveDateTime: isoDateTime(lastVisit),
    issued: isoDateTime(lastVisit + 3_600_000),
    performer: [{ reference: practitioner }],
    presentedForm: [{ contentType: "text/plain", data: base64(noteText) }],
  });

  push({ resourceType: "Binary", id: `syn-binary-${short}-note`, contentType: "text/plain", data: base64(noteText) });
  const clinicalNote = { system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category" };
  // The inline note is always a progress note; the other rotates through the remaining note types by patient.
  const otherType = NOTE_TYPES[1 + ((n - 1) % (NOTE_TYPES.length - 1))];
  for (const [suffix, attachment, type] of [
    ["inline", { contentType: "text/plain", data: base64(noteText) }, NOTE_TYPES[0]],
    ["binary", { contentType: "text/plain", url: `Binary/syn-binary-${short}-note` }, otherType],
  ] as const) {
    push({
      resourceType: "DocumentReference",
      id: `syn-documentreference-${short}-${suffix}`,
      identifier: [{ system: DOCUMENT_SYSTEM, value: `SYN-DOC-${short}-${suffix}` }],
      status: "current",
      type: loinc(type.code, type.display),
      category: [{ coding: [{ ...clinicalNote, code: "clinical-note", display: "Clinical Note" }] }],
      subject,
      date: isoDateTime(lastVisit + 3_600_000),
      author: [{ reference: practitioner }],
      content: [
        {
          attachment,
          format: {
            system: "http://ihe.net/fhir/ValueSet/IHE.FormatCode.codesystem",
            code: "urn:ihe:iti:xds:2017:mimeTypeSufficient",
            display: "mimeType Sufficient",
          },
        },
      ],
      context: {
        encounter: [encounter(visit)],
        period: { start: isoDateTime(lastVisit), end: isoDateTime(lastVisit + 30 * 60_000) },
      },
    });
  }

  const procedure = rng.pick(PROCEDURES);
  push({
    resourceType: "Procedure",
    id: `syn-procedure-${short}-1`,
    status: "completed",
    code: { coding: [{ system: ICD10PCS, ...procedure }], text: procedure.display },
    subject,
    encounter: encounter(visit),
    performedDateTime: isoDateTime(lastVisit + 10 * 60_000),
  });

  push({
    resourceType: "Goal",
    id: `syn-goal-${short}-1`,
    lifecycleStatus: "active",
    description: { text: pediatric ? "Stay up to date on well-child visits" : "Walk 30 minutes five days a week" },
    subject,
    target: [{ dueDate: isoDate(reference + rng.int(90, 365) * DAY) }],
  });

  push({
    resourceType: "CarePlan",
    id: `syn-careplan-${short}-1`,
    text: narrative("Assessment and plan: continue current treatment and follow up in three months."),
    status: "active",
    intent: "plan",
    category: [
      {
        coding: [
          {
            system: "http://hl7.org/fhir/us/core/CodeSystem/careplan-category",
            code: "assess-plan",
            display: "Assessment and Plan of Treatment",
          },
        ],
      },
    ],
    subject,
    period: { start: isoDate(lastVisit) },
  });

  push({
    resourceType: "CareTeam",
    id: `syn-careteam-${short}-1`,
    status: "active",
    subject,
    participant: [
      { role: [{ text: "Primary care physician" }], member: { reference: practitioner } },
      { role: [{ text: "Patient" }], member: subject },
    ],
  });

  // Every fifth patient, starting with the third, has an implanted device.
  if (n % 5 === 3) {
    push({
      resourceType: "Device",
      id: `syn-device-${short}-1`,
      udiCarrier: [
        {
          deviceIdentifier: "00000000000000",
          carrierHRF: `(01)00000000000000(11)200101(17)300101(10)SYN${short}(21)SYN-SERIAL-${short}`,
          carrierAIDC: base64(`0100000000000000112001011730010110SYN${short}`),
        },
      ],
      distinctIdentifier: `SYN-DEVICE-${short}`,
      manufactureDate: "2020-01-01",
      expirationDate: "2030-01-01",
      lotNumber: `SYN${short}`,
      serialNumber: `SYN-SERIAL-${short}`,
      type: uncoded("Cardiac pacemaker"),
      patient: subject,
    });
  }

  // Every fifth patient, starting with the first, declined a vaccine on a date nobody recorded.
  if (n % 5 === 1) {
    push({
      resourceType: "Immunization",
      id: `syn-immunization-${short}-declined`,
      status: "not-done",
      statusReason: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
            code: "PATOBJ",
            display: "patient objection",
          },
        ],
      },
      vaccineCode: { coding: [{ system: CVX, ...VACCINES[0] }], text: VACCINES[0].display },
      patient: subject,
      _occurrenceDateTime: absent("unknown"),
      primarySource: true,
    });
  }
}

/** One US Core Provenance per patient: the practitioner authored the record and the clinic sent it. */
function provenance(
  records: FhirResource[],
  short: string,
  practitioner: string,
  organization: string,
  encounterStarts: number[],
): FhirResource {
  return tagged({
    resourceType: "Provenance",
    id: `syn-provenance-${short}`,
    target: records.filter((r) => r.resourceType !== "Binary").map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
    recorded: isoDateTime(Math.max(...encounterStarts) + 3_600_000),
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "author",
              display: "Author",
            },
          ],
        },
        who: { reference: practitioner },
        onBehalfOf: { reference: organization },
      },
      {
        type: {
          coding: [
            {
              system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-provenance-participant-type",
              code: "transmitter",
              display: "Transmitter",
            },
          ],
        },
        who: { reference: organization },
      },
    ],
  });
}
