import { DEFAULT_GENERATE_OPTIONS, generateSyntheticRecords, type GenerateOptions } from "./generator.js";
import { parseScenarios } from "./scenarios.js";

/** One synthetic person, as the FHIR generator creates them, for emulators that are not FHIR servers. */
export interface SyntheticPerson {
  /** The FHIR Patient id, such as syn-patient-001. */
  id: string;
  /** The MRN on the FHIR Patient (identifier typed MR), such as SYN-000001. */
  mrn: string;
  family: string;
  given: string;
  /** YYYY-MM-DD */
  birthDate: string;
  gender: "female" | "male" | "other" | "unknown";
  address: { line: string; city: string; state: string; postalCode: string };
  phone: string;
  /** Scenario packs applied to this person. */
  scenarios: string[];
  /** Inpatient stays from the person's Encounters (class IMP). */
  admissions: Array<{ visitNumber: string; admitted: string; discharged?: string; location: string }>;
}

/**
 * The people of a synthetic population. The same options give the same people that the FHIR, EHR, payer, and device
 * emulators serve, so other emulators can describe the same patients. Person n is the same whatever the total.
 */
export function syntheticPeople(options: GenerateOptions = {}): SyntheticPerson[] {
  const records = generateSyntheticRecords(options);
  const scenarios = parseScenarios(options.scenarios, options.patients ?? DEFAULT_GENERATE_OPTIONS.patients);
  const inpatient = records.filter((r: any) => r.resourceType === "Encounter" && r.class?.code === "IMP") as any[];
  return records
    .filter((r) => r.resourceType === "Patient")
    .map((p: any) => {
      const name = p.name.find((n: any) => n.use === "official") ?? p.name[0];
      const address = p.address.find((a: any) => a.use === "home") ?? p.address[0];
      return {
        id: p.id,
        mrn: p.identifier.find((i: any) => i.type?.text === "MRN")?.value ?? p.id,
        family: name.family,
        given: name.given[0],
        birthDate: p.birthDate,
        gender: p.gender,
        address: { line: address.line[0], city: address.city, state: address.state, postalCode: address.postalCode },
        phone: p.telecom?.find((t: any) => t.system === "phone")?.value ?? "",
        scenarios: scenarios.filter((x) => x.patientId === p.id).map((x) => x.name),
        admissions: inpatient
          .filter((e) => e.subject.reference === `Patient/${p.id}`)
          .map((e) => ({
            visitNumber: e.identifier?.[0]?.value ?? e.id,
            admitted: e.period.start,
            ...(e.period.end ? { discharged: e.period.end } : {}),
            location: e.location?.[0]?.location?.display ?? "",
          })),
      };
    });
}
