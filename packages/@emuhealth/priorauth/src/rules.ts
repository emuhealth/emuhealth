// The synthetic payer's coverage rules for durable medical equipment and services, keyed by HCPCS Level II code
// (public, CMS). They decide CRD coverage information, which DTR questionnaire applies, and the PAS decision.

export const HCPCS = "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";

export type Decision = "approved" | "pended" | "denied";

export interface CoverageRule {
  code: string;
  display: string;
  covered: "covered" | "not-covered" | "conditional";
  /** CRD pa-needed: whether prior authorization is required. */
  paNeeded: "no-auth" | "auth-needed";
  /** CRD doc-needed: documentation to collect, if any. */
  docNeeded?: "clinical" | "admin" | "both";
  /** DTR questionnaire for the documentation. */
  questionnaire?: string;
  /** PAS decision for a complete request: approved at once, pended until inquired, or denied. */
  decision: Decision;
  note: string;
}

export const RULES: CoverageRule[] = [
  {
    code: "E0601",
    display: "Continuous positive airway pressure (CPAP) device",
    covered: "covered",
    paNeeded: "auth-needed",
    docNeeded: "clinical",
    questionnaire: "home-cpap",
    decision: "pended",
    note: "Prior authorization required. Document a sleep study and an adherence plan.",
  },
  {
    code: "E1390",
    display: "Oxygen concentrator, single delivery port",
    covered: "covered",
    paNeeded: "auth-needed",
    docNeeded: "clinical",
    questionnaire: "home-oxygen",
    decision: "approved",
    note: "Prior authorization required. Document qualifying oxygen saturation.",
  },
  {
    code: "K0001",
    display: "Standard wheelchair",
    covered: "covered",
    paNeeded: "no-auth",
    decision: "approved",
    note: "Covered without prior authorization.",
  },
  {
    code: "E0260",
    display: "Hospital bed, semi-electric, with any type side rails, with mattress",
    covered: "conditional",
    paNeeded: "auth-needed",
    docNeeded: "admin",
    questionnaire: "hospital-bed",
    decision: "denied",
    note: "Covered only for qualifying conditions; the synthetic plan denies requests without them.",
  },
];

export const ruleFor = (code: string | undefined) => RULES.find((r) => r.code === code);
