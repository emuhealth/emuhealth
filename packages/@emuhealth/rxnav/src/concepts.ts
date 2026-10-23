// A small RxNorm subset: the ingredients and clinical drugs the emuhealth patient generator uses, checked against
// NLM RxNav. RxNorm is published by the U.S. National Library of Medicine; see THIRD_PARTY_NOTICES.md.

export interface RxConcept {
  rxcui: string;
  name: string;
  tty: string;
  synonym?: string;
  /** Ingredient rxcuis for clinical drugs. */
  ingredients?: string[];
}

export const DEFAULT_CONCEPTS: RxConcept[] = [
  { rxcui: "29046", name: "lisinopril", tty: "IN" },
  { rxcui: "6809", name: "metformin", tty: "IN" },
  { rxcui: "83367", name: "atorvastatin", tty: "IN" },
  { rxcui: "435", name: "albuterol", tty: "IN" },
  { rxcui: "7646", name: "omeprazole", tty: "IN" },
  { rxcui: "36437", name: "sertraline", tty: "IN" },
  { rxcui: "723", name: "amoxicillin", tty: "IN" },
  { rxcui: "7980", name: "penicillin G", tty: "IN" },
  { rxcui: "314076", name: "lisinopril 10 MG Oral Tablet", tty: "SCD", ingredients: ["29046"] },
  { rxcui: "861007", name: "metformin hydrochloride 500 MG Oral Tablet", tty: "SCD", ingredients: ["6809"] },
  { rxcui: "617310", name: "atorvastatin 20 MG Oral Tablet", tty: "SCD", ingredients: ["83367"] },
  {
    rxcui: "2123111",
    name: "NDA020503 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler",
    tty: "SCD",
    ingredients: ["435"],
  },
  { rxcui: "198051", name: "omeprazole 20 MG Delayed Release Oral Capsule", tty: "SCD", ingredients: ["7646"] },
  { rxcui: "312941", name: "sertraline 50 MG Oral Tablet", tty: "SCD", ingredients: ["36437"] },
];
