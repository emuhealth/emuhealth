import { describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";
import { applyPopulation, validatePopulation } from "../population.js";

const population = { patients: 7, seed: 9 };

describe("shared population", () => {
  it("gives FHIR, Epic, HL7 v2, and Rave the same people", async () => {
    const seed = { population };
    const fhir = await createEmulator({ service: "fhir", port: 0, seed });
    const epic = await createEmulator({ service: "epic", port: 0, seed });
    const hl7 = await createEmulator({ service: "hl7v2", port: 0, seed: { ...seed, hl7v2: { mllp: false } } });
    const rave = await createEmulator({ service: "rave", port: 0, seed });
    try {
      const fhirPatients = (await (await fetch(`${fhir.url}/Patient?_count=50&_sort=_id`)).json()) as any;
      expect(fhirPatients.total).toBe(7);
      const people = fhirPatients.entry.map((e: any) => e.resource);
      const epicPatients = (await (await fetch(`${epic.url}/api/FHIR/R4/Patient?_count=50&_sort=_id`)).json()) as any;
      expect(epicPatients.entry.map((e: any) => e.resource.name[0].family)).toEqual(
        people.map((p: any) => p.name[0].family),
      );

      const registry = (await (await fetch(`${hl7.url}/patients`)).json()) as any;
      expect(registry.patients).toHaveLength(7);
      const seventh = registry.patients.find((p: any) => p.identifiers[0].id === "syn-patient-007");
      expect(seventh.family).toBe(people[6].name[0].family.toUpperCase());
      expect(seventh.birthDate).toBe(people[6].birthDate.replace(/-/g, ""));

      const auth = { Authorization: `Basic ${Buffer.from("rws.synthetic:synthetic-password").toString("base64")}` };
      const dm = await (
        await fetch(`${rave.url}/RaveWebServices/studies/EMU-101(Prod)/subjects/101-001/datasets/regular/DM`, {
          headers: auth,
        })
      ).text();
      expect(dm).toContain(`ItemOID="DM.BRTHDAT" Value="${people[0].birthDate}"`);
    } finally {
      await Promise.all([fhir.close(), epic.close(), hl7.close(), rave.close()]);
    }
  });

  it("lets a service's own generate setting win and validates the key", () => {
    expect(applyPopulation("fhir", { generate: false }, population)).toEqual({ generate: false });
    expect(applyPopulation("stedi", undefined, population)).toEqual({ generate: population });
    expect(applyPopulation("rave", { generate: { subjects: 3 } }, population)).toEqual({
      generate: { subjects: 3, population },
    });
    expect(applyPopulation("github", undefined, population)).toBeUndefined();
    expect(() => validatePopulation({ patients: 2000 })).toThrow("population.patients");
    expect(() => validatePopulation({ people: 3 })).toThrow("unknown option people");
  });
});

describe("scenario packs through population", () => {
  it("reaches FHIR, HL7 v2, and Rave from one key", async () => {
    const seed = { population: { scenarios: ["inpatient-stay", "trial-adverse-event"] } };
    const fhir = await createEmulator({ service: "fhir", port: 0, seed });
    const hl7 = await createEmulator({ service: "hl7v2", port: 0, seed: { ...seed, hl7v2: { mllp: false } } });
    const rave = await createEmulator({ service: "rave", port: 0, seed });
    try {
      const stay = (await (await fetch(`${fhir.url}/Encounter?class=IMP`)).json()) as any;
      expect(stay.entry[0].resource.subject.reference).toBe("Patient/syn-patient-002");
      const patient = (await (await fetch(`${hl7.url}/patients/syn-patient-002`)).json()) as any;
      expect(patient.visits[0]).toMatchObject({ patientClass: "I", status: "discharged" });
      const auth = { Authorization: `Basic ${Buffer.from("rws.synthetic:synthetic-password").toString("base64")}` };
      const ae = await (
        await fetch(`${rave.url}/RaveWebServices/studies/EMU-101(Prod)/datasets/regular/AE`, { headers: auth })
      ).text();
      expect(ae).toContain('ItemOID="AE.AETERM" Value="Syncope"');
    } finally {
      await Promise.all([fhir.close(), hl7.close(), rave.close()]);
    }
  });
});
