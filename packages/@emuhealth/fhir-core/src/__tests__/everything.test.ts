import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, type FhirResource } from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

// Synthetic records only.
const records: FhirResource[] = [
  { resourceType: "Organization", id: "org1", name: "Example Clinic" },
  { resourceType: "Practitioner", id: "dr1", name: [{ family: "Example" }] },
  {
    resourceType: "Patient",
    id: "p1",
    managingOrganization: { reference: "Organization/org1" },
    generalPractitioner: [{ reference: "Practitioner/dr1" }],
  },
  { resourceType: "Patient", id: "p2" },
  {
    resourceType: "Encounter",
    id: "e1",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  },
  {
    resourceType: "Observation",
    id: "o1",
    status: "final",
    code: { text: "Heart rate" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    performer: [{ reference: "Practitioner/dr1" }],
  },
  // Mentions both patients: it belongs to p1, and p2 must not be pulled in through it.
  {
    resourceType: "Observation",
    id: "o2",
    status: "final",
    code: { text: "Family history note" },
    subject: { reference: "Patient/p1" },
    focus: [{ reference: "Patient/p2" }],
  },
  {
    resourceType: "Observation",
    id: "o3",
    status: "final",
    code: { text: "Other" },
    subject: { reference: "Patient/p2" },
  },
  { resourceType: "AllergyIntolerance", id: "a1", patient: { reference: `${base}/Patient/p1` } },
];

function createApp() {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { resources: records });
  return app;
}

async function everything(app: Hono, path: string) {
  const res: JsonResponse = await app.request(`${base}${path}`);
  const body = await res.json();
  return {
    status: res.status,
    body,
    keys: (body.entry ?? []).map((e: { resource: FhirResource }) => `${e.resource.resourceType}/${e.resource.id}`),
  };
}

describe("Patient/$everything", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("returns the patient, its records, and the resources they reference", async () => {
    const { status, body, keys } = await everything(app, "/Patient/p1/$everything");
    expect(status).toBe(200);
    expect(body.type).toBe("searchset");
    expect(keys).toEqual([
      "Patient/p1",
      "Encounter/e1",
      "Observation/o1",
      "Observation/o2",
      "AllergyIntolerance/a1",
      "Organization/org1",
      "Practitioner/dr1",
    ]);
    expect(body.total).toBe(7);
    expect(keys).not.toContain("Patient/p2");
    expect(keys).not.toContain("Observation/o3");
  });

  it("filters by _type and _since", async () => {
    expect((await everything(app, "/Patient/p1/$everything?_type=Observation,Patient")).keys).toEqual([
      "Patient/p1",
      "Observation/o1",
      "Observation/o2",
    ]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await everything(app, `/Patient/p1/$everything?_since=${future}`)).body.total).toBe(0);
    expect((await everything(app, "/Patient/p1/$everything?_type=Spaceship")).status).toBe(400);
    expect((await everything(app, "/Patient/p1/$everything?_since=soon")).status).toBe(400);
  });

  it("pages with _count", async () => {
    const first = await everything(app, "/Patient/p1/$everything?_count=3");
    expect(first.keys).toHaveLength(3);
    expect(first.body.total).toBe(7);
    const next = first.body.link.find((l: { relation: string }) => l.relation === "next").url;
    expect(next).toBe(`${base}/Patient/p1/$everything?_count=3&_getpagesoffset=3`);
    const second = await everything(app, next.slice(base.length));
    expect(second.keys).toEqual(["Observation/o2", "AllergyIntolerance/a1", "Organization/org1"]);
  });

  it("returns 404 for unknown and 410 for deleted patients", async () => {
    expect((await everything(app, "/Patient/missing/$everything")).status).toBe(404);
    await app.request(`${base}/Patient/p2`, { method: "DELETE" });
    const gone = await everything(app, "/Patient/p2/$everything");
    expect(gone.status).toBe(410);
    expect(gone.body.resourceType).toBe("OperationOutcome");
  });

  it("covers every patient at the type level", async () => {
    const { keys } = await everything(app, "/Patient/$everything");
    expect(keys).toEqual(expect.arrayContaining(["Patient/p1", "Patient/p2", "Observation/o3", "Practitioner/dr1"]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is advertised in the CapabilityStatement", async () => {
    const cs = await ((await app.request(`${base}/metadata`)) as JsonResponse).json();
    const patient = cs.rest[0].resource.find((r: { type: string }) => r.type === "Patient");
    expect(patient.operation).toEqual([
      { name: "everything", definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything" },
    ]);
  });
});

describe("Patient/$everything over generated data", () => {
  it("returns a full synthetic record", async () => {
    const app = new Hono();
    const store = new Store();
    fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
    fhirPlugin.seed?.(store, base);
    const { body, keys } = await everything(app, "/Patient/syn-patient-001/$everything?_count=500");
    expect(keys[0]).toBe("Patient/syn-patient-001");
    const types = new Set(keys.map((k: string) => k.split("/")[0]));
    for (const type of ["Encounter", "Observation", "Immunization", "Practitioner", "Organization"])
      expect(types).toContain(type);
    expect(keys.filter((k: string) => k.startsWith("Patient/"))).toEqual(["Patient/syn-patient-001"]);
    expect(body.total).toBe(keys.length);
  });
});
