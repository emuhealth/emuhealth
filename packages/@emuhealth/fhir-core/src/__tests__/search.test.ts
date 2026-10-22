import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, dateRange, type FhirResource } from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

const LOINC = "http://loinc.org";
const MRN = "urn:example:mrn";

// Synthetic records only.
const resources: FhirResource[] = [
  {
    resourceType: "Patient",
    id: "p1",
    identifier: [{ system: MRN, value: "1001" }],
    name: [{ family: "Álvarez", given: ["Ana"] }],
    gender: "female",
    birthDate: "1980-05-17",
    active: true,
  },
  {
    resourceType: "Patient",
    id: "p2",
    identifier: [{ system: MRN, value: "1002" }],
    name: [{ family: "Brooks", given: ["Ben", "Lee"] }],
    gender: "male",
    birthDate: "1975-11-02",
    active: false,
  },
  {
    resourceType: "Patient",
    id: "p3",
    name: [{ family: "Alvarado", given: ["Cleo"] }],
    gender: "female",
    birthDate: "1992",
  },
  {
    resourceType: "Observation",
    id: "o1",
    status: "final",
    category: [
      { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] },
    ],
    code: { coding: [{ system: LOINC, code: "8867-4", display: "Heart rate" }], text: "Pulse" },
    subject: { reference: "Patient/p1" },
    effectiveDateTime: "2026-01-10T09:30:00Z",
  },
  {
    resourceType: "Observation",
    id: "o2",
    status: "preliminary",
    code: { coding: [{ system: LOINC, code: "8310-5", display: "Body temperature" }] },
    subject: { reference: "Patient/p2" },
    effectivePeriod: { start: "2026-02-01T08:00:00Z", end: "2026-02-01T09:00:00Z" },
  },
  {
    resourceType: "Observation",
    id: "o3",
    status: "final",
    code: { coding: [{ system: LOINC, code: "8867-4", display: "Heart rate" }] },
    subject: { reference: "http://localhost:4100/Patient/p1" },
    effectiveDateTime: "2026-03-05",
  },
];

function createApp() {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { resources });
  return app;
}

function get(app: Hono, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return app.request(`${base}${path}`, { headers });
}

async function ids(app: Hono, path: string): Promise<string[]> {
  const res = await get(app, path);
  expect(res.status).toBe(200);
  const bundle = await res.json();
  return bundle.entry.map((e: { resource: FhirResource }) => e.resource.id);
}

describe("fhir-core search", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("returns a searchset Bundle with every current resource of the type", async () => {
    const res = await get(app, "/Patient");
    const bundle = await res.json();
    expect(res.headers.get("Content-Type")).toContain("application/fhir+json");
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(3);
    expect(bundle.entry[0]).toMatchObject({ fullUrl: `${base}/Patient/p1`, search: { mode: "match" } });
    expect(bundle.link[0]).toEqual({ relation: "self", url: `${base}/Patient` });
  });

  it("excludes deleted resources", async () => {
    await app.request(`${base}/Patient/p2`, { method: "DELETE" });
    expect(await ids(app, "/Patient")).toEqual(["p1", "p3"]);
  });

  it("supports _id and _lastUpdated", async () => {
    expect(await ids(app, "/Patient?_id=p2,p3")).toEqual(["p2", "p3"]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await ids(app, `/Patient?_lastUpdated=${today}`)).toHaveLength(3);
    expect(await ids(app, "/Patient?_lastUpdated=lt2000-01-01")).toEqual([]);
  });

  it("matches strings by accent- and case-insensitive prefix, with :exact and :contains", async () => {
    expect(await ids(app, "/Patient?family=alv")).toEqual(["p1", "p3"]);
    expect(await ids(app, "/Patient?name=lee")).toEqual(["p2"]);
    expect(await ids(app, "/Patient?family:exact=Álvarez")).toEqual(["p1"]);
    expect(await ids(app, "/Patient?family:exact=alvarez")).toEqual([]);
    expect(await ids(app, "/Patient?family:contains=ooK")).toEqual(["p2"]);
  });

  it("matches tokens by code, system|code, |code, and :not / :text", async () => {
    expect(await ids(app, "/Patient?gender=female")).toEqual(["p1", "p3"]);
    expect(await ids(app, `/Patient?identifier=${encodeURIComponent(`${MRN}|1002`)}`)).toEqual(["p2"]);
    expect(await ids(app, "/Patient?identifier=other|1002")).toEqual([]);
    expect(await ids(app, "/Patient?active=true")).toEqual(["p1"]);
    expect(await ids(app, `/Observation?code=${encodeURIComponent(`${LOINC}|8867-4`)}`)).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?code=8310-5")).toEqual(["o2"]);
    expect(await ids(app, "/Observation?status:not=final")).toEqual(["o2"]);
    expect(await ids(app, "/Observation?code:text=heart")).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?category=vital-signs")).toEqual(["o1"]);
  });

  it("searches CodeableConcept text with and without codings", async () => {
    await app.request(`${base}/Observation`, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Observation", status: "final", code: { text: "Respiratory rate" } }),
    });
    expect((await (await get(app, "/Observation?code:text=respiratory")).json()).total).toBe(1);
    // o1 has a coding display and a different concept text; both are searchable.
    expect(await ids(app, "/Observation?code:text=heart")).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?code:text=pulse")).toEqual(["o1"]);
    expect((await (await get(app, "/Observation?code=respiratory")).json()).total).toBe(0);
  });

  it("matches dates with precision and prefixes, including periods", async () => {
    expect(await ids(app, "/Patient?birthdate=1980")).toEqual(["p1"]);
    expect(await ids(app, "/Patient?birthdate=1980-05-17")).toEqual(["p1"]);
    expect(await ids(app, "/Patient?birthdate=lt1980-01-01")).toEqual(["p2"]);
    expect(await ids(app, "/Patient?birthdate=ge1980-05-17")).toEqual(["p1", "p3"]);
    expect(await ids(app, "/Patient?birthdate=ne1980-05-17")).toEqual(["p2", "p3"]);
    expect(await ids(app, "/Observation?date=2026-02")).toEqual(["o2"]);
    expect(await ids(app, "/Observation?date=gt2026-02-01&date=lt2026-12-31")).toEqual(["o3"]);
    expect(await ids(app, "/Observation?date=sa2026-01-31")).toEqual(["o2", "o3"]);
    expect(await ids(app, "/Observation?date=eb2026-02-01")).toEqual(["o1"]);
    expect((await get(app, "/Patient?birthdate=yesterday")).status).toBe(400);
  });

  it("matches references by id, Type/id, absolute URL, and :Type", async () => {
    expect(await ids(app, "/Observation?patient=p1")).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?subject=Patient/p2")).toEqual(["o2"]);
    expect(await ids(app, `/Observation?subject=${encodeURIComponent(`${base}/Patient/p1`)}`)).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?subject:Patient=p2")).toEqual(["o2"]);
    expect(await ids(app, "/Observation?subject=p2")).toEqual(["o2"]);
  });

  it("combines repeated parameters with AND and comma values with OR, and supports :missing", async () => {
    expect(await ids(app, "/Observation?status=final&patient=p1&code=8867-4")).toEqual(["o1", "o3"]);
    expect(await ids(app, "/Observation?status=final,preliminary")).toEqual(["o1", "o2", "o3"]);
    expect(await ids(app, "/Patient?identifier:missing=true")).toEqual(["p3"]);
    expect(await ids(app, "/Patient?identifier:missing=false")).toEqual(["p1", "p2"]);
  });

  it("sorts by one or more parameters", async () => {
    expect(await ids(app, "/Patient?_sort=birthdate")).toEqual(["p2", "p1", "p3"]);
    expect(await ids(app, "/Patient?_sort=-birthdate")).toEqual(["p3", "p1", "p2"]);
    expect(await ids(app, "/Patient?_sort=gender,-family")).toEqual(["p1", "p3", "p2"]);
    expect(await ids(app, "/Observation?_sort=-date")).toEqual(["o3", "o2", "o1"]);
  });

  it("pages with _count and next and previous links", async () => {
    const first = await (await get(app, "/Patient?_sort=family&_count=2")).json();
    expect(first.total).toBe(3);
    expect(first.entry.map((e: { resource: FhirResource }) => e.resource.id)).toEqual(["p3", "p1"]);
    const next = first.link.find((l: { relation: string }) => l.relation === "next").url;
    expect(next).toBe(`${base}/Patient?_sort=family&_count=2&_getpagesoffset=2`);
    const second = await ((await app.request(next)) as JsonResponse).json();
    expect(second.entry.map((e: { resource: FhirResource }) => e.resource.id)).toEqual(["p2"]);
    expect(second.link.map((l: { relation: string }) => l.relation)).toEqual(["self", "previous"]);
  });

  it("returns only the total for _summary=count", async () => {
    const bundle = await (await get(app, "/Patient?gender=female&_summary=count")).json();
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toEqual([]);
  });

  it("ignores unknown parameters unless Prefer: handling=strict", async () => {
    const lenient = await (await get(app, "/Patient?shoe-size=9&gender=male")).json();
    expect(lenient.total).toBe(1);
    expect(lenient.link[0].url).toBe(`${base}/Patient?gender=male`);
    const strict = await get(app, "/Patient?shoe-size=9", { Prefer: "handling=strict" });
    expect(strict.status).toBe(400);
    expect((await strict.json()).resourceType).toBe("OperationOutcome");
  });

  it("accepts POST _search with form parameters", async () => {
    const res: JsonResponse = await app.request(`${base}/Patient/_search?gender=female`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "family=alvarado",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).entry.map((e: { resource: FhirResource }) => e.resource.id)).toEqual(["p3"]);
    const json = await app.request(`${base}/Patient/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
  });

  it("returns 404 for unknown resource types", async () => {
    expect((await get(app, "/Spaceship")).status).toBe(404);
  });
});

describe("dateRange", () => {
  it("covers the whole period of partial dates", () => {
    expect(dateRange("2026")).toEqual({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1) });
    expect(dateRange("2026-02")).toEqual({ start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 2, 1) });
    expect(dateRange("2026-12-31")).toEqual({ start: Date.UTC(2026, 11, 31), end: Date.UTC(2027, 0, 1) });
    expect(dateRange("2026-01-10T09:30:00+02:00")?.start).toBe(Date.UTC(2026, 0, 10, 7, 30));
    expect(dateRange("not a date")).toBeUndefined();
  });
});
