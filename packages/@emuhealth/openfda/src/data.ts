// Deterministic synthetic openFDA datasets: drug labels, adverse event reports, and recalls (enforcement reports).
// Nothing here is FDA data. Drugs are the generic products the emuhealth patient generator prescribes, with RxNorm
// codes; label text, manufacturers, reports, and recalls are invented.

export type OpenFdaRecord = Record<string, unknown>;

export const ENDPOINTS = [
  "drug/label",
  "drug/event",
  "drug/enforcement",
  "device/enforcement",
  "food/enforcement",
] as const;
export type Endpoint = (typeof ENDPOINTS)[number];
export type Datasets = Record<Endpoint, OpenFdaRecord[]>;

export interface GenerateOptions {
  /** PRNG seed; the same seed always produces the same records. Default 1. */
  seed?: number;
  /** Number of adverse event reports, 0 to 5000. Default 300. */
  events?: number;
}

interface Drug {
  generic: string;
  rxcui: string;
  product: string;
  route: string;
  form: string;
  pharmClass: string;
  indication: string;
  reactions: string[];
}

// RxNorm codes match the emuhealth patient generator's medications and drug allergens.
const DRUGS: Drug[] = [
  {
    generic: "LISINOPRIL",
    rxcui: "314076",
    product: "lisinopril 10 MG Oral Tablet",
    route: "ORAL",
    form: "TABLET",
    pharmClass: "Angiotensin Converting Enzyme Inhibitor [EPC]",
    indication: "Hypertension",
    reactions: ["Cough", "Dizziness", "Headache", "Hyperkalaemia", "Angioedema"],
  },
  {
    generic: "METFORMIN HYDROCHLORIDE",
    rxcui: "861007",
    product: "metformin hydrochloride 500 MG Oral Tablet",
    route: "ORAL",
    form: "TABLET",
    pharmClass: "Biguanide [EPC]",
    indication: "Type 2 diabetes mellitus",
    reactions: ["Diarrhoea", "Nausea", "Abdominal pain", "Lactic acidosis", "Vomiting"],
  },
  {
    generic: "ATORVASTATIN CALCIUM",
    rxcui: "617310",
    product: "atorvastatin 20 MG Oral Tablet",
    route: "ORAL",
    form: "TABLET",
    pharmClass: "HMG-CoA Reductase Inhibitor [EPC]",
    indication: "Hyperlipidaemia",
    reactions: ["Myalgia", "Arthralgia", "Fatigue", "Rhabdomyolysis", "Nausea"],
  },
  {
    generic: "ALBUTEROL SULFATE",
    rxcui: "2123111",
    product: "albuterol 0.09 MG/ACTUAT Metered Dose Inhaler",
    route: "RESPIRATORY (INHALATION)",
    form: "AEROSOL, METERED",
    pharmClass: "beta2-Adrenergic Agonist [EPC]",
    indication: "Asthma",
    reactions: ["Tremor", "Palpitations", "Nervousness", "Headache", "Tachycardia"],
  },
  {
    generic: "OMEPRAZOLE",
    rxcui: "198051",
    product: "omeprazole 20 MG Delayed Release Oral Capsule",
    route: "ORAL",
    form: "CAPSULE, DELAYED RELEASE",
    pharmClass: "Proton Pump Inhibitor [EPC]",
    indication: "Gastrooesophageal reflux disease",
    reactions: ["Headache", "Abdominal pain", "Nausea", "Diarrhoea", "Flatulence"],
  },
  {
    generic: "SERTRALINE HYDROCHLORIDE",
    rxcui: "312941",
    product: "sertraline 50 MG Oral Tablet",
    route: "ORAL",
    form: "TABLET",
    pharmClass: "Serotonin Reuptake Inhibitor [EPC]",
    indication: "Generalised anxiety disorder",
    reactions: ["Nausea", "Insomnia", "Somnolence", "Dry mouth", "Dizziness"],
  },
  {
    generic: "AMOXICILLIN",
    rxcui: "723",
    product: "amoxicillin",
    route: "ORAL",
    form: "CAPSULE",
    pharmClass: "Penicillin-class Antibacterial [EPC]",
    indication: "Bacterial infection",
    reactions: ["Rash", "Diarrhoea", "Urticaria", "Nausea", "Hypersensitivity"],
  },
  {
    generic: "PENICILLIN G POTASSIUM",
    rxcui: "7980",
    product: "penicillin G",
    route: "INTRAVENOUS",
    form: "INJECTION, POWDER, FOR SOLUTION",
    pharmClass: "Penicillin-class Antibacterial [EPC]",
    indication: "Bacterial infection",
    reactions: ["Rash", "Anaphylactic reaction", "Pyrexia", "Urticaria", "Hypersensitivity"],
  },
];

const FIRMS = [
  { name: "Synthetic Pharmaceuticals Inc.", city: "Springfield", state: "IL" },
  { name: "Example Generics LLC", city: "Fairview", state: "OR" },
  { name: "Placeholder Labs Corp.", city: "Riverton", state: "WY" },
];

const RECALL_REASONS = [
  "Failed Dissolution Specifications",
  "Presence of Foreign Substance",
  "Subpotent Drug",
  "Labeling: Incorrect or Missing Lot and/or Exp Date",
  "CGMP Deviations",
  "Failed Impurities/Degradation Specifications",
];
const DEVICE_RECALLS = [
  { product: "Synthetic infusion pump, model SYN-100", reason: "Software may stop the infusion without an alarm" },
  { product: "Synthetic blood glucose test strips, lot SYN-GL", reason: "Strips may read falsely high" },
  { product: "Synthetic pulse oximeter, model SYN-OX", reason: "Display may freeze during use" },
];
const FOOD_RECALLS = [
  { product: "Synthetic Trail Mix, 8 oz bags", reason: "Undeclared peanuts" },
  { product: "Example Brand Frozen Shrimp, 1 lb", reason: "Potential Listeria monocytogenes contamination" },
  { product: "Placeholder Granola Bars, 6 count", reason: "Undeclared milk" },
];

/** mulberry32, the same PRNG as the patient generator. */
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

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
/** A deterministic UUID-shaped id; the 5e7e prefix marks it as emuhealth synthetic data. */
const uuid = (n: number, kind: number) => `5e7e${pad(kind, 4)}-0000-4000-8000-${pad(n, 12)}`;

function openfda(drug: Drug, firm: (typeof FIRMS)[number], labelIndex: number): OpenFdaRecord {
  return {
    brand_name: [drug.generic],
    generic_name: [drug.generic],
    manufacturer_name: [firm.name],
    product_type: ["HUMAN PRESCRIPTION DRUG"],
    route: [drug.route],
    substance_name: [drug.generic.replace(/ (HYDROCHLORIDE|CALCIUM|SULFATE|POTASSIUM)$/, "")],
    rxcui: [drug.rxcui],
    spl_id: [uuid(labelIndex, 1)],
    spl_set_id: [uuid(labelIndex, 2)],
    pharm_class_epc: [drug.pharmClass],
  };
}

function label(drug: Drug, index: number): OpenFdaRecord {
  const firm = FIRMS[index % FIRMS.length];
  const name = drug.generic.toLowerCase();
  return {
    id: uuid(index, 1),
    set_id: uuid(index, 2),
    version: "1",
    effective_time: "20250101",
    openfda: openfda(drug, firm, index),
    spl_product_data_elements: [`${drug.generic} ${drug.form}`],
    indications_and_usage: [
      `INDICATIONS AND USAGE Synthetic label for local development. ${drug.generic} is used to treat ${drug.indication.toLowerCase()}.`,
    ],
    dosage_and_administration: [
      `DOSAGE AND ADMINISTRATION Synthetic text. Use ${name} as directed by a clinician. Route: ${drug.route.toLowerCase()}.`,
    ],
    contraindications: [`CONTRAINDICATIONS Synthetic text. Do not use in patients with hypersensitivity to ${name}.`],
    warnings_and_cautions: [`WARNINGS AND PRECAUTIONS Synthetic text. Monitor for ${drug.reactions[3].toLowerCase()}.`],
    adverse_reactions: [
      `ADVERSE REACTIONS Synthetic text. The most common adverse reactions are ${drug.reactions
        .slice(0, 3)
        .map((r) => r.toLowerCase())
        .join(", ")}.`,
    ],
    description: [`DESCRIPTION Synthetic label generated by emuhealth. Not FDA data. ${drug.generic} ${drug.form}.`],
    package_label_principal_display_panel: [`PRINCIPAL DISPLAY PANEL ${drug.generic} ${drug.form} Rx only. SYNTHETIC.`],
  };
}

/** Generate the default datasets. Output is a pure function of the options. */
export function generateDatasets(options: GenerateOptions = {}): Datasets {
  const seed = options.seed ?? 1;
  const events = options.events ?? 300;
  if (!Number.isInteger(seed)) throw new Error("openfda.generate.seed must be an integer");
  if (!Number.isInteger(events) || events < 0 || events > 5000)
    throw new Error("openfda.generate.events must be an integer from 0 to 5000");
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const start = Date.parse("2023-01-01T00:00:00Z");
  const day = 86_400_000;

  const labels = DRUGS.map((drug, i) => label(drug, i + 1));

  const reports: OpenFdaRecord[] = [];
  for (let n = 1; n <= events; n++) {
    const index = int(0, DRUGS.length - 1);
    const drug = DRUGS[index];
    const received = start + int(0, 1094) * day;
    const serious = random() < 0.3;
    const reactions = [...new Set([pick(drug.reactions), pick(drug.reactions)])];
    reports.push({
      safetyreportid: `SYN${pad(n, 8)}`,
      safetyreportversion: "1",
      receivedate: ymd(received),
      receiptdate: ymd(received),
      transmissiondate: ymd(received + 30 * day),
      serious: serious ? "1" : "2",
      ...(serious ? { seriousnesshospitalization: "1" } : {}),
      occurcountry: "US",
      primarysourcecountry: "US",
      reporttype: "1",
      primarysource: { qualification: String(pick([1, 2, 3, 5])), reportercountry: "US" },
      sender: { sendertype: "2", senderorganization: "FDA-Public Use" },
      patient: {
        patientonsetage: String(int(18, 85)),
        patientonsetageunit: "801",
        patientsex: String(int(1, 2)),
        reaction: reactions.map((term) => ({ reactionmeddrapt: term, reactionoutcome: String(pick([1, 2, 6])) })),
        drug: [
          {
            drugcharacterization: "1",
            medicinalproduct: drug.generic,
            drugindication: drug.indication.toUpperCase(),
            drugadministrationroute: drug.route === "ORAL" ? "048" : "065",
            activesubstance: { activesubstancename: drug.generic },
            openfda: openfda(drug, FIRMS[(index + 1) % FIRMS.length], index + 1),
          },
        ],
      },
    });
  }

  const recall = (
    n: number,
    letter: string,
    productType: string,
    product: string,
    reason: string,
    extra: OpenFdaRecord = {},
  ) => {
    const firm = FIRMS[n % FIRMS.length];
    const initiated = start + int(0, 1000) * day;
    const status = pick(["Ongoing", "Completed", "Terminated"]);
    return {
      recall_number: `${letter}-${pad(n, 4)}-SYN`,
      event_id: String(90000 + n),
      status,
      classification: pick(["Class I", "Class II", "Class II", "Class III"]),
      product_type: productType,
      product_description: product,
      reason_for_recall: reason,
      recalling_firm: firm.name,
      city: firm.city,
      state: firm.state,
      country: "United States",
      voluntary_mandated: "Voluntary: Firm initiated",
      initial_firm_notification: "Letter",
      distribution_pattern: "Nationwide",
      code_info: `Lot SYN${pad(n, 5)}`,
      product_quantity: `${int(1, 50) * 1000} units`,
      recall_initiation_date: ymd(initiated),
      center_classification_date: ymd(initiated + 20 * day),
      report_date: ymd(initiated + 27 * day),
      ...(status === "Terminated" ? { termination_date: ymd(initiated + 300 * day) } : {}),
      ...extra,
    };
  };

  const drugRecalls = Array.from({ length: 12 }, (_, i) => {
    const index = i % DRUGS.length;
    const drug = DRUGS[index];
    return recall(
      i + 1,
      "D",
      "Drugs",
      `${drug.generic} ${drug.form}, Rx only, 100 count bottle. Synthetic product.`,
      pick(RECALL_REASONS),
      { openfda: openfda(drug, FIRMS[(i + 1) % FIRMS.length], index + 1) },
    );
  });
  const deviceRecalls = DEVICE_RECALLS.map((r, i) => recall(i + 1, "Z", "Devices", r.product, r.reason));
  const foodRecalls = FOOD_RECALLS.map((r, i) => recall(i + 1, "F", "Food", r.product, r.reason));

  return {
    "drug/label": labels,
    "drug/event": reports,
    "drug/enforcement": drugRecalls,
    "device/enforcement": deviceRecalls,
    "food/enforcement": foodRecalls,
  };
}
