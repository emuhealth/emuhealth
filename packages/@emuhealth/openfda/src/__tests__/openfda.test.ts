import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  generateDatasets,
  openfdaPlugin,
  parseSearch,
  matches,
  seedFromConfig,
  type OpenFdaSeedConfig,
} from "../index.js";

const base = "http://localhost:4102";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function startService(config?: OpenFdaSeedConfig) {
  const app = new Hono();
  const store = new Store();
  openfdaPlugin.register(app as never, store, new WebhookDispatcher(), base);
  openfdaPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return (path: string) => app.request(`${base}${path}`) as Promise<JsonResponse>;
}

describe("generated datasets", () => {
  it("are deterministic and synthetic", () => {
    expect(generateDatasets({ seed: 3 })).toEqual(generateDatasets({ seed: 3 }));
    const data = generateDatasets();
    expect(data["drug/label"]).toHaveLength(8);
    expect(data["drug/event"]).toHaveLength(300);
    for (const label of data["drug/label"]) expect(String(label.description)).toContain("Not FDA data");
    expect(() => generateDatasets({ events: 6000 })).toThrow("events");
  });
});

describe("query language", () => {
  const record = {
    openfda: { brand_name: ["LISINOPRIL"], route: ["ORAL"] },
    patient: { reaction: [{ reactionmeddrapt: "Dry mouth" }], patientonsetage: "54" },
    receivedate: "20240115",
  };
  const test = (search: string) => matches(record, parseSearch(search));

  it("matches fields, phrases, exact values, and wildcards", () => {
    expect(test("openfda.brand_name:lisinopril")).toBe(true);
    expect(test('patient.reaction.reactionmeddrapt:"dry mouth"')).toBe(true);
    expect(test('patient.reaction.reactionmeddrapt:"mouth dry"')).toBe(false);
    expect(test('patient.reaction.reactionmeddrapt.exact:"Dry mouth"')).toBe(true);
    expect(test('patient.reaction.reactionmeddrapt.exact:"dry mouth"')).toBe(false);
    expect(test("openfda.brand_name:lisino*")).toBe(true);
    expect(test("lisinopril")).toBe(true);
  });

  it("combines clauses with AND, OR, NOT, and parentheses", () => {
    expect(test("openfda.brand_name:lisinopril AND openfda.route:oral")).toBe(true);
    expect(test("openfda.brand_name:metformin AND openfda.route:oral")).toBe(false);
    expect(test("openfda.brand_name:metformin openfda.route:oral")).toBe(true);
    expect(test("openfda.brand_name:metformin OR openfda.route:oral")).toBe(true);
    expect(test("NOT openfda.brand_name:metformin")).toBe(true);
    expect(test("(openfda.brand_name:metformin OR openfda.brand_name:lisinopril) AND openfda.route:oral")).toBe(true);
    expect(test("openfda.brand_name:(metformin lisinopril)")).toBe(true);
  });

  it("handles ranges and field existence", () => {
    expect(test("receivedate:[20240101 TO 20241231]")).toBe(true);
    expect(test("receivedate:[20250101 TO 20251231]")).toBe(false);
    expect(test("patient.patientonsetage:[50 TO 60]")).toBe(true);
    expect(test("_exists_:openfda.route")).toBe(true);
    expect(test("_missing_:openfda.route")).toBe(false);
  });
});

describe("openFDA endpoints", () => {
  it("returns meta and one result by default", async () => {
    const get = startService();
    const res = await get("/drug/label.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.results).toEqual({ skip: 0, limit: 1, total: 8 });
    expect(body.meta.disclaimer).toContain("Synthetic");
    expect(body.results).toHaveLength(1);
  });

  it("searches, sorts, and pages like openFDA", async () => {
    const get = startService();
    const label = await (await get("/drug/label.json?search=openfda.generic_name:metformin")).json();
    expect(label.results[0].openfda.rxcui).toEqual(["861007"]);
    const page = await (
      await get(
        "/drug/event.json?search=patient.drug.openfda.generic_name:lisinopril+AND+serious:1&limit=5&skip=1&sort=receivedate:desc",
      )
    ).json();
    expect(page.meta.results.skip).toBe(1);
    expect(page.results.length).toBeLessThanOrEqual(5);
    const dates = page.results.map((r: { receivedate: string }) => r.receivedate);
    expect([...dates].sort().reverse()).toEqual(dates);
    const recalls = await (await get('/drug/enforcement.json?search=classification:"Class+II"&limit=100')).json();
    expect(recalls.results.every((r: { classification: string }) => r.classification === "Class II")).toBe(true);
  });

  it("counts terms", async () => {
    const get = startService();
    const counts = await (await get("/drug/event.json?count=patient.reaction.reactionmeddrapt.exact&limit=3")).json();
    expect(counts.results).toHaveLength(3);
    expect(counts.results[0].count).toBeGreaterThanOrEqual(counts.results[1].count);
    expect(typeof counts.results[0].term).toBe("string");
    const words = await (await get("/drug/label.json?count=openfda.route")).json();
    expect(words.results.map((r: { term: string }) => r.term)).toContain("oral");
  });

  it("answers errors the way openFDA does", async () => {
    const get = startService();
    const none = await get("/drug/label.json?search=openfda.generic_name:nothing");
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: { code: "NOT_FOUND", message: "No matches found!" } });
    const tooMany = await get("/drug/event.json?limit=1001");
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error.code).toBe("BAD_REQUEST");
    expect((await get("/drug/label.json?search=(openfda.route:oral")).status).toBe(400);
    expect((await get("/drug/unknown.json")).status).toBe(404);
  });

  it("loads extra records and can start empty", async () => {
    const get = startService({
      generate: false,
      records: { "drug/label": [{ id: "custom-1", openfda: { generic_name: ["EXAMPLEMAB"] } }] },
    });
    const body = await (await get("/drug/label.json?search=openfda.generic_name:examplemab")).json();
    expect(body.meta.results.total).toBe(1);
    expect((await get("/drug/event.json")).status).toBe(404);
    expect(() => startService({ records: { "drug/unknown": [] } as never })).toThrow("unknown endpoint");
  });

  it("serves an inspector built on the shared UI", async () => {
    const get = startService();
    const res = await get("/_inspector?tab=drug/event");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("inspector-table");
    expect(html).toContain("SYN00000001");
  });
});
