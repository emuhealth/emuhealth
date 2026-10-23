import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  createFhirInstance,
  fhirPlugin,
  parseFhirVersion,
  R4B_RESOURCE_TYPES,
  R5_RESOURCE_TYPES,
  seedFromConfig,
  type FhirSeedConfig,
} from "../index.js";

const base = "http://localhost:4100";

function startService(config?: FhirSeedConfig) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`${base}${path}`, init);
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: (await res.json()) as any };
  };
  return { req, store };
}

describe("FHIR versions", () => {
  it("parses version names", () => {
    expect(parseFhirVersion("R5")).toBe("5.0.0");
    expect(parseFhirVersion("r4b")).toBe("4.3.0");
    expect(parseFhirVersion("4.0")).toBe("4.0.1");
    expect(parseFhirVersion("3.0.2")).toBeUndefined();
    expect(() => startService({ fhirVersion: "STU3" })).toThrow(/fhirVersion/);
  });

  it("knows each version's resource types", () => {
    expect(R4B_RESOURCE_TYPES.has("SubscriptionTopic")).toBe(true);
    expect(R4B_RESOURCE_TYPES.has("MedicinalProduct")).toBe(false);
    expect(R5_RESOURCE_TYPES.has("DeviceAssociation")).toBe(true);
    expect(R5_RESOURCE_TYPES.has("DeviceUseStatement")).toBe(false);
    expect(R5_RESOURCE_TYPES.size).toBe(158);
    expect(R4B_RESOURCE_TYPES.size).toBe(141);
  });

  it("keeps R4 as the default and rejects other requested versions", async () => {
    const { req } = startService();
    const meta = await req("/metadata");
    expect(meta.body.fhirVersion).toBe("4.0.1");
    expect(meta.type).toBe("application/fhir+json; charset=utf-8");
    expect((await req("/$versions")).body.parameter).toEqual([
      { name: "version", valueCode: "4.0" },
      { name: "default", valueCode: "4.0" },
    ]);
    const asked = await req("/Patient", { headers: { Accept: "application/fhir+json; fhirVersion=5.0" } });
    expect(asked.status).toBe(406);
    expect(asked.body.resourceType).toBe("OperationOutcome");
    expect((await req("/Patient", { headers: { Accept: "application/fhir+json; fhirVersion=4.0" } })).status).toBe(200);
    expect((await req("/SubscriptionTopic")).status).toBe(404);
  });

  it("serves R5 with R5 shaped synthetic data", async () => {
    const { req } = startService({ fhirVersion: "R5" });
    const meta = await req("/metadata", { headers: { Accept: "application/fhir+json; fhirVersion=5.0" } });
    expect(meta.body.fhirVersion).toBe("5.0.0");
    expect(meta.type).toBe("application/fhir+json; fhirVersion=5.0; charset=utf-8");
    expect(meta.body.rest[0].resource.some((r: any) => r.type === "DeviceAssociation")).toBe(true);
    expect((await req("/$versions", { headers: { Accept: "application/json" } })).body).toEqual({
      versions: ["5.0"],
      default: "5.0",
    });

    const encounters = await req("/Encounter?patient=syn-patient-001");
    const enc = encounters.body.entry[0].resource;
    expect(enc.status).toBe("completed");
    expect(enc.class[0].coding[0].code).toBe("AMB");
    expect(enc.actualPeriod.start).toBeDefined();
    expect(enc.period).toBeUndefined();
    expect(enc.participant[0].actor.reference).toMatch(/^Practitioner\//);
    expect(enc.reason[0].value[0].concept).toBeDefined();
    const start = enc.actualPeriod.start.slice(0, 10);
    expect((await req(`/Encounter?patient=syn-patient-001&date=${start}`)).body.total).toBeGreaterThan(0);
    expect((await req("/Encounter?class=AMB")).body.total).toBeGreaterThan(0);

    const meds = await req("/MedicationRequest");
    const med = meds.body.entry[0].resource;
    expect(med.medication.concept.coding[0].system).toBe("http://www.nlm.nih.gov/research/umls/rxnorm");
    expect(med.medicationCodeableConcept).toBeUndefined();
    const code = med.medication.concept.coding[0].code;
    expect((await req(`/MedicationRequest?code=${code}`)).body.total).toBeGreaterThan(0);

    const proc = (await req("/Procedure")).body.entry[0].resource;
    expect(proc.occurrenceDateTime).toBeDefined();
    const doc = (await req("/DocumentReference")).body.entry[0].resource;
    expect(doc.context[0].reference).toMatch(/^Encounter\//);
    expect(doc.content[0].profile[0].valueCoding.code).toBe("urn:ihe:iti:xds:2017:mimeTypeSufficient");
    const endpoint = (await req("/Endpoint/syn-endpoint-1")).body;
    expect(endpoint.connectionType[0].coding[0].code).toBe("hl7-fhir-rest");
    expect(endpoint.payload[0].type[0].text).toBe("FHIR R5 resources");

    const devices = (await req("/Device")).body.entry ?? [];
    for (const d of devices) expect(d.resource.patient).toBeUndefined();
    const associations = (await req("/DeviceAssociation")).body;
    expect(associations.total).toBe(devices.length);

    const created = await req("/SubscriptionTopic", {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json; fhirVersion=5.0" },
      body: JSON.stringify({ resourceType: "SubscriptionTopic", status: "draft", url: "urn:example:topic" }),
    });
    expect(created.status).toBe(201);
    const wrongBody = await req("/Patient", {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json; fhirVersion=4.0" },
      body: JSON.stringify({ resourceType: "Patient" }),
    });
    expect(wrongBody.status).toBe(415);
    expect((await req("/DeviceUseStatement")).status).toBe(404);
  });

  it("serves R4B with R4 shaped data and R4B types", async () => {
    const { req } = startService({ fhirVersion: "4.3.0" });
    const meta = await req("/metadata");
    expect(meta.body.fhirVersion).toBe("4.3.0");
    expect(meta.type).toContain("fhirVersion=4.3");
    expect((await req("/Encounter")).body.entry[0].resource.class.code).toBe("AMB");
    expect((await req("/SubscriptionTopic")).status).toBe(200);
    expect((await req("/MedicinalProduct")).status).toBe(404);
  });

  it("keeps the version across reset-style reseeding and in FHIR instances", async () => {
    const instance = createFhirInstance({ baseUrl: base, fhirVersion: "5.0.0", generate: { patients: 1 } });
    const res = await instance.app.request(`${base}/Encounter`);
    const body = (await res.json()) as any;
    expect(body.entry[0].resource.actualPeriod).toBeDefined();
    const { req, store } = startService({ fhirVersion: "R5" });
    store.reset();
    fhirPlugin.seed?.(store, base);
    expect((await req("/metadata")).body.fhirVersion).toBe("5.0.0");
    expect((await req("/Encounter")).body.entry[0].resource.actualPeriod).toBeDefined();
  });
});
