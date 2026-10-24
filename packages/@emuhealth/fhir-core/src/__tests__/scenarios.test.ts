import { describe, expect, it } from "vitest";
import { generateSyntheticRecords, syntheticPeople, toR5 } from "../index.js";

const ids = (records: Array<{ resourceType: string; id?: string }>) => records.map((r) => `${r.resourceType}/${r.id}`);

describe("scenario packs", () => {
  it("adds records without changing any other record", () => {
    const plain = generateSyntheticRecords();
    const withScenarios = generateSyntheticRecords({
      scenarios: ["diabetes-cgm", "inpatient-stay", "trial-adverse-event"],
    });
    expect(withScenarios.slice(0, plain.length)).toEqual(plain);
    const added = withScenarios.slice(plain.length);
    expect(ids(added)).toEqual(
      expect.arrayContaining([
        "Observation/syn-observation-001-scn-a1c-4",
        "Device/syn-device-001-scn-cgm",
        "Encounter/syn-encounter-002-scn-inpatient",
        "DocumentReference/syn-documentreference-002-scn-discharge",
        "ResearchSubject/syn-researchsubject-003-emu-101",
        "AdverseEvent/syn-adverseevent-003-scn-syncope",
      ]),
    );
    expect(added.filter((r) => r.resourceType === "ResearchStudy")).toHaveLength(1);
  });

  it("targets a chosen patient and reports scenarios and admissions on people", () => {
    const people = syntheticPeople({
      patients: 6,
      scenarios: [{ name: "inpatient-stay", patient: "syn-patient-005" }],
    });
    expect(people[4].scenarios).toEqual(["inpatient-stay"]);
    expect(people[4].admissions).toEqual([
      expect.objectContaining({ visitNumber: "V-005-INPT", location: "3W ward, room 312" }),
    ]);
    expect(people[1].admissions).toEqual([]);
  });

  it("rejects unknown scenarios and patients outside the population", () => {
    expect(() => generateSyntheticRecords({ scenarios: ["nope" as never] })).toThrow("must name one of");
    expect(() =>
      generateSyntheticRecords({ scenarios: [{ name: "diabetes-cgm", patient: "syn-patient-009" }] }),
    ).toThrow("is not one of the 5 generated patients");
  });

  it("converts the trial resources to R5", () => {
    const records = generateSyntheticRecords({ scenarios: ["trial-adverse-event"] });
    const r5 = toR5(records.filter((r) => ["ResearchSubject", "AdverseEvent"].includes(r.resourceType)));
    const subject = r5.find((r) => r.resourceType === "ResearchSubject") as any;
    expect(subject.subject.reference).toBe("Patient/syn-patient-003");
    expect(subject.progress[0].subjectState.coding[0].code).toBe("on-study");
    const event = r5.find((r) => r.resourceType === "AdverseEvent") as any;
    expect(event).toMatchObject({ status: "completed", code: { text: "Syncope" } });
    expect(toR5([subject, event])).toEqual([subject, event]);
  });
});
