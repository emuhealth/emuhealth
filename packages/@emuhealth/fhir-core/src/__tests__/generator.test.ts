import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  fhirPlugin,
  seedFromConfig,
  generateSyntheticRecords,
  isR4ResourceType,
  SYNTHETIC_TAG,
  type FhirResource,
} from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function references(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) references(v, out);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (key === "reference" && typeof child === "string") out.push(child);
      else references(child, out);
    }
  return out;
}

/** Start the fhir service the way the CLI does: plugin seed, then config. */
function startService(config?: Parameters<typeof seedFromConfig>[2]) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  const total = async (path: string) =>
    ((await ((await app.request(`${base}${path}`)) as JsonResponse).json()) as { total: number }).total;
  return { app, store, total };
}

describe("generateSyntheticRecords", () => {
  it("is deterministic for a seed and varies across seeds", () => {
    expect(generateSyntheticRecords({ seed: 7 })).toEqual(generateSyntheticRecords({ seed: 7 }));
    expect(generateSyntheticRecords({ seed: 7 })).not.toEqual(generateSyntheticRecords({ seed: 8 }));
  });

  it("produces the requested number of patients plus shared organization and practitioners", () => {
    const records = generateSyntheticRecords({ patients: 12, seed: 3 });
    const count = (type: string) => records.filter((r) => r.resourceType === type).length;
    expect(count("Patient")).toBe(12);
    expect(count("Organization")).toBe(1);
    expect(count("Practitioner")).toBe(2);
    expect(count("Encounter")).toBeGreaterThanOrEqual(12);
    expect(count("Observation")).toBeGreaterThanOrEqual(12 * 7);
    expect(count("Immunization")).toBeGreaterThanOrEqual(12);
    expect(count("Provenance")).toBe(12);
    expect(generateSyntheticRecords({ patients: 0 }).map((r) => r.resourceType)).toEqual([
      "Organization",
      "Location",
      "Endpoint",
      "Practitioner",
      "PractitionerRole",
      "Practitioner",
      "PractitionerRole",
    ]);
  });

  it("only emits tagged R4 resources with unique, valid ids and resolvable references", () => {
    const records = generateSyntheticRecords({ patients: 25, seed: 11 });
    const keys = new Set(records.map((r) => `${r.resourceType}/${r.id}`));
    expect(keys.size).toBe(records.length);
    for (const record of records) {
      expect(isR4ResourceType(record.resourceType)).toBe(true);
      expect(record.id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/);
      expect(record.meta?.tag).toEqual([SYNTHETIC_TAG]);
      for (const ref of references(record)) expect(keys.has(ref), `${record.id} -> ${ref}`).toBe(true);
    }
  });

  it("dates records relative to referenceDate and keeps synthetic identifiers", () => {
    const records = generateSyntheticRecords({ patients: 20, seed: 5, referenceDate: "2030-06-01" });
    for (const patient of records.filter((r) => r.resourceType === "Patient") as Array<FhirResource & any>) {
      const age = (Date.parse("2030-06-01") - Date.parse(patient.birthDate)) / (365.25 * 86_400_000);
      // Every fifth patient, starting with the fourth, is a two-year-old.
      if (Number(patient.id.slice(-3)) % 5 === 4) expect(Math.floor(age)).toBe(2);
      else expect(age).toBeGreaterThanOrEqual(18);
      expect(age).toBeLessThan(87);
      expect(patient.identifier[0].system).toBe("urn:emuhealth:synthetic:mrn");
      expect(patient.telecom[0].value).toMatch(/^555-01\d{2}$/);
    }
    for (const encounter of records.filter((r) => r.resourceType === "Encounter") as Array<FhirResource & any>)
      expect(Date.parse(encounter.period.start)).toBeLessThan(Date.parse("2030-06-01"));
  });

  it("rejects invalid options", () => {
    expect(() => generateSyntheticRecords({ patients: -1 })).toThrow("patients");
    expect(() => generateSyntheticRecords({ patients: 1001 })).toThrow("patients");
    expect(() => generateSyntheticRecords({ seed: 1.5 })).toThrow("seed");
    expect(() => generateSyntheticRecords({ referenceDate: "June 2026" })).toThrow("referenceDate");
  });
});

describe("fhir service default population", () => {
  it("starts with five synthetic patients that search can find", async () => {
    const { total } = startService();
    expect(await total("/Patient")).toBe(5);
    expect(await total("/Observation?code=http://loinc.org|8867-4&_summary=count")).toBeGreaterThanOrEqual(5);
    expect(await total("/Encounter?patient=syn-patient-001")).toBeGreaterThanOrEqual(1);
    expect(await total(`/Patient?_id=syn-patient-001&_revinclude=Observation:patient`)).toBe(1);
  });

  it("replaces the population with fhir.generate and keeps fhir.resources", async () => {
    const { total } = startService({
      generate: { patients: 2, seed: 9 },
      resources: [{ resourceType: "Patient", id: "extra", name: [{ family: "Example" }] }],
    });
    expect(await total("/Patient")).toBe(3);
  });

  it("starts without generated patients with fhir.generate: false, and empty with terminology: false too", async () => {
    const noPatients = startService({ generate: false });
    expect(await noPatients.total("/Patient")).toBe(0);
    expect(await noPatients.total("/CodeSystem")).toBe(7);
    const empty = startService({ generate: false, terminology: false });
    expect(await empty.total("/_history")).toBe(0);
  });

  it("rejects a non-object generate value", () => {
    expect(() => startService({ generate: 5 as never })).toThrow("fhir.generate");
  });
});
