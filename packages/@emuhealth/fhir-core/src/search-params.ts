export type SearchParamType = "string" | "token" | "date" | "reference";

export interface SearchParamDefinition {
  name: string;
  type: SearchParamType;
  /** Dotted element paths; arrays are flattened along the way. "a|b" style choice paths are listed separately. */
  paths: string[];
  /** Reference parameters: the resource types a bare id refers to (for example patient means Patient). */
  targets?: string[];
}

const p = (name: string, type: SearchParamType, paths: string[], targets?: string[]): SearchParamDefinition => ({
  name,
  type,
  paths,
  ...(targets ? { targets } : {}),
});

/** Parameters every resource type supports. */
export const COMMON_SEARCH_PARAMS: SearchParamDefinition[] = [
  p("_id", "token", ["id"]),
  p("_lastUpdated", "date", ["meta.lastUpdated"]),
  // Most resources have identifiers, and conditional creates and updates match on them.
  p("identifier", "token", ["identifier"]),
];

const patientRef = (path = "subject") => [
  p("patient", "reference", [path], ["Patient"]),
  p("subject", "reference", [path]),
];
const encounterRef = p("encounter", "reference", ["encounter"], ["Encounter"]);
const humanName = [
  p("name", "string", ["name"]),
  p("family", "string", ["name.family"]),
  p("given", "string", ["name.given"]),
];

/**
 * Search parameters per resource type, following the FHIR R4 and US Core definitions for the common cases.
 * Where R5 renamed an element, both paths are listed so the same definitions serve every version.
 */
export const SEARCH_PARAMS: Record<string, SearchParamDefinition[]> = {
  Patient: [
    p("identifier", "token", ["identifier"]),
    ...humanName,
    p("gender", "token", ["gender"]),
    p("birthdate", "date", ["birthDate"]),
    p("active", "token", ["active"]),
    p("telecom", "token", ["telecom"]),
    p("address", "string", ["address"]),
    p("address-city", "string", ["address.city"]),
    p("address-state", "string", ["address.state"]),
    p("address-postalcode", "string", ["address.postalCode"]),
    p("general-practitioner", "reference", ["generalPractitioner"]),
    p("organization", "reference", ["managingOrganization"], ["Organization"]),
  ],
  Practitioner: [p("identifier", "token", ["identifier"]), ...humanName, p("active", "token", ["active"])],
  PractitionerRole: [
    p("practitioner", "reference", ["practitioner"], ["Practitioner"]),
    p("organization", "reference", ["organization"], ["Organization"]),
    p("specialty", "token", ["specialty"]),
    p("role", "token", ["code"]),
    p("location", "reference", ["location"], ["Location"]),
    p("active", "token", ["active"]),
    // Plan-Net's network-reference extension; PractitionerRole carries no other reference extensions.
    p("network", "reference", ["extension.valueReference"], ["Organization"]),
  ],
  Organization: [
    p("identifier", "token", ["identifier"]),
    p("name", "string", ["name", "alias"]),
    p("active", "token", ["active"]),
    p("address", "string", ["address", "contact.address"]),
    p("type", "token", ["type"]),
    p("partof", "reference", ["partOf"], ["Organization"]),
  ],
  HealthcareService: [
    p("identifier", "token", ["identifier"]),
    p("active", "token", ["active"]),
    p("name", "string", ["name"]),
    p("location", "reference", ["location"], ["Location"]),
    p("organization", "reference", ["providedBy"], ["Organization"]),
    p("service-category", "token", ["category"]),
    p("service-type", "token", ["type"]),
    p("specialty", "token", ["specialty"]),
    p("endpoint", "reference", ["endpoint"], ["Endpoint"]),
  ],
  InsurancePlan: [
    p("identifier", "token", ["identifier"]),
    p("name", "string", ["name", "alias"]),
    p("status", "token", ["status"]),
    p("type", "token", ["type"]),
    p("owned-by", "reference", ["ownedBy"], ["Organization"]),
    p("administered-by", "reference", ["administeredBy"], ["Organization"]),
    p("coverage-area", "reference", ["coverageArea"], ["Location"]),
    p("plan-type", "token", ["plan.type"]),
  ],
  OrganizationAffiliation: [
    p("active", "token", ["active"]),
    p("primary-organization", "reference", ["organization"], ["Organization"]),
    p("participating-organization", "reference", ["participatingOrganization"], ["Organization"]),
    p("network", "reference", ["network"], ["Organization"]),
    p("location", "reference", ["location"], ["Location"]),
    p("role", "token", ["code"]),
    p("specialty", "token", ["specialty"]),
    p("endpoint", "reference", ["endpoint"], ["Endpoint"]),
  ],
  Endpoint: [
    p("identifier", "token", ["identifier"]),
    p("name", "string", ["name"]),
    p("status", "token", ["status"]),
    p("organization", "reference", ["managingOrganization"], ["Organization"]),
    p("connection-type", "token", ["connectionType"]),
  ],
  Location: [
    p("identifier", "token", ["identifier"]),
    p("name", "string", ["name", "alias"]),
    p("address", "string", ["address"]),
    p("address-city", "string", ["address.city"]),
    p("address-state", "string", ["address.state"]),
    p("address-postalcode", "string", ["address.postalCode"]),
    p("organization", "reference", ["managingOrganization"], ["Organization"]),
    p("type", "token", ["type"]),
  ],
  Observation: [
    ...patientRef(),
    encounterRef,
    p("code", "token", ["code"]),
    p("category", "token", ["category"]),
    p("status", "token", ["status"]),
    p("date", "date", ["effectiveDateTime", "effectivePeriod", "effectiveInstant"]),
    p("value-concept", "token", ["valueCodeableConcept"]),
  ],
  Condition: [
    ...patientRef(),
    encounterRef,
    p("code", "token", ["code"]),
    p("category", "token", ["category"]),
    p("clinical-status", "token", ["clinicalStatus"]),
    p("verification-status", "token", ["verificationStatus"]),
    p("onset-date", "date", ["onsetDateTime", "onsetPeriod"]),
    p("recorded-date", "date", ["recordedDate"]),
  ],
  Encounter: [
    ...patientRef(),
    p("identifier", "token", ["identifier"]),
    p("status", "token", ["status"]),
    p("class", "token", ["class"]),
    p("type", "token", ["type"]),
    p("date", "date", ["period", "actualPeriod"]),
    p("location", "reference", ["location.location"], ["Location"]),
    p("practitioner", "reference", ["participant.individual", "participant.actor"], ["Practitioner"]),
  ],
  MedicationRequest: [
    ...patientRef(),
    encounterRef,
    p("status", "token", ["status"]),
    p("intent", "token", ["intent"]),
    p("code", "token", ["medicationCodeableConcept", "medication.concept"]),
    p("authoredon", "date", ["authoredOn"]),
    p("requester", "reference", ["requester"]),
  ],
  AllergyIntolerance: [
    ...patientRef("patient"),
    p("code", "token", ["code"]),
    p("clinical-status", "token", ["clinicalStatus"]),
    p("verification-status", "token", ["verificationStatus"]),
    p("category", "token", ["category"]),
    p("criticality", "token", ["criticality"]),
  ],
  Immunization: [
    ...patientRef("patient"),
    p("status", "token", ["status"]),
    p("vaccine-code", "token", ["vaccineCode"]),
    p("date", "date", ["occurrenceDateTime"]),
  ],
  Procedure: [
    ...patientRef(),
    encounterRef,
    p("code", "token", ["code"]),
    p("status", "token", ["status"]),
    p("date", "date", ["performedDateTime", "performedPeriod", "occurrenceDateTime", "occurrencePeriod"]),
  ],
  DiagnosticReport: [
    ...patientRef(),
    encounterRef,
    p("code", "token", ["code"]),
    p("category", "token", ["category"]),
    p("status", "token", ["status"]),
    p("date", "date", ["effectiveDateTime", "effectivePeriod"]),
    p("result", "reference", ["result"], ["Observation"]),
  ],
  DocumentReference: [
    ...patientRef(),
    p("type", "token", ["type"]),
    p("category", "token", ["category"]),
    p("status", "token", ["status"]),
    p("date", "date", ["date"]),
    p("period", "date", ["context.period", "period"]),
  ],
  CarePlan: [
    ...patientRef(),
    p("category", "token", ["category"]),
    p("status", "token", ["status"]),
    p("date", "date", ["period"]),
  ],
  CareTeam: [...patientRef(), p("status", "token", ["status"])],
  Goal: [
    ...patientRef(),
    p("lifecycle-status", "token", ["lifecycleStatus"]),
    p("target-date", "date", ["target.dueDate"]),
  ],
  ServiceRequest: [
    ...patientRef(),
    encounterRef,
    p("code", "token", ["code"]),
    p("status", "token", ["status"]),
    p("authored", "date", ["authoredOn"]),
  ],
  Coverage: [
    p("patient", "reference", ["beneficiary"], ["Patient"]),
    p("beneficiary", "reference", ["beneficiary"]),
    p("status", "token", ["status"]),
    p("payor", "reference", ["payor"]),
  ],
  Device: [p("patient", "reference", ["patient"], ["Patient"]), p("type", "token", ["type"])],
  Medication: [p("code", "token", ["code"])],
  ExplanationOfBenefit: [
    p("patient", "reference", ["patient"], ["Patient"]),
    p("type", "token", ["type"]),
    p("status", "token", ["status"]),
    p("service-date", "date", ["billablePeriod"]),
    p("created", "date", ["created"]),
    p("provider", "reference", ["provider"]),
    p("coverage", "reference", ["insurance.coverage"], ["Coverage"]),
  ],
  Provenance: [
    p("target", "reference", ["target"]),
    p("patient", "reference", ["target"], ["Patient"]),
    p("agent", "reference", ["agent.who"]),
    p("recorded", "date", ["recorded"]),
  ],
  CodeSystem: [
    p("url", "token", ["url"]),
    p("system", "token", ["url"]),
    p("name", "string", ["name", "title"]),
    p("status", "token", ["status"]),
    p("version", "token", ["version"]),
  ],
  ValueSet: [
    p("url", "token", ["url"]),
    p("name", "string", ["name", "title"]),
    p("status", "token", ["status"]),
    p("version", "token", ["version"]),
  ],
};

/** Types with no identifier element. */
const NO_IDENTIFIER = new Set(["Binary", "Parameters", "OperationOutcome"]);

export function searchParamsFor(type: string): Map<string, SearchParamDefinition> {
  const common = NO_IDENTIFIER.has(type)
    ? COMMON_SEARCH_PARAMS.filter((d) => d.name !== "identifier")
    : COMMON_SEARCH_PARAMS;
  return new Map([...common, ...(SEARCH_PARAMS[type] ?? [])].map((d) => [d.name, d]));
}
