import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { generateProviders, nppesPlugin, seedFromConfig, syntheticNpi, type NppesSeedConfig } from "../index.js";

const base = "http://localhost:4106";

function startService(config?: NppesSeedConfig) {
  const app = new Hono();
  const store = new Store();
  nppesPlugin.register(app as never, store, new WebhookDispatcher(), base);
  nppesPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string) => {
    const res = await app.request(`${base}${path}`);
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

/** The NPI check digit: Luhn over the 80840 prefix. */
function validNpi(npi: string): boolean {
  const digits = `80840${npi}`.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

describe("synthetic providers", () => {
  it("have valid check digits but can never be real NPIs", () => {
    expect(generateProviders({ seed: 9 })).toEqual(generateProviders({ seed: 9 }));
    const all = generateProviders();
    expect(all.filter((p) => p.enumeration_type === "NPI-1")).toHaveLength(40);
    expect(all.filter((p) => p.enumeration_type === "NPI-2")).toHaveLength(15);
    for (const p of all) {
      expect(p.number).toMatch(/^0\d{9}$/);
      expect(validNpi(p.number as string)).toBe(true);
    }
    expect(validNpi(syntheticNpi(42))).toBe(true);
  });
});

describe("NPI Registry API", () => {
  it("searches by name, type, place, and taxonomy", async () => {
    const get = startService();
    const all = generateProviders();
    const person = all.find((p) => p.enumeration_type === "NPI-1")! as any;
    const byName = await get(
      `/api/?version=2.1&first_name=${person.basic.first_name.toLowerCase()}&last_name=${person.basic.last_name}`,
    );
    expect(byName.body.result_count).toBeGreaterThan(0);
    expect(byName.body.results.map((r: any) => r.number)).toContain(person.number);
    const byNumber = await get(`/api/?version=2.1&number=${person.number}`);
    expect(byNumber.body).toMatchObject({ result_count: 1, results: [{ number: person.number }] });
    const wildcard = await get(`/api/?version=2.1&last_name=${person.basic.last_name.slice(0, 3)}*&limit=200`);
    for (const r of wildcard.body.results)
      expect(r.basic.last_name.startsWith(person.basic.last_name.slice(0, 3))).toBe(true);
    const orgs = await get("/api/?version=2.1&organization_name=*&city=springfield&enumeration_type=NPI-2&limit=200");
    expect(orgs.body.Errors).toBeDefined();
    const hospitals = await get("/api/?version=2.1&taxonomy_description=hospital&limit=200");
    for (const r of hospitals.body.results) expect(r.enumeration_type).toBe("NPI-2");
    const paged = await get("/api/?version=2.1&city=springfield&limit=2&skip=1");
    expect(paged.body.results.length).toBeLessThanOrEqual(2);
  });

  it("returns the registry's error shapes", async () => {
    const get = startService();
    expect((await get("/api/?last_name=smith")).body).toEqual({
      Errors: [{ description: "Unsupported Version", field: "version", number: "17" }],
    });
    expect((await get("/api/?version=2.1&state=IL")).body).toEqual({
      Errors: [{ description: "No valid search criteria provided", field: "generic", number: "04" }],
    });
    expect((await get("/api/?version=2.1&number=123")).body.Errors[0].field).toBe("number");
    expect((await get("/api/?version=2.1&number=0000000000")).body).toEqual({ result_count: 0, results: [] });
  });

  it("loads your providers and can start empty", async () => {
    const get = startService({
      generate: false,
      providers: [
        { number: "0999999990", enumeration_type: "NPI-1", basic: { first_name: "JAMIE", last_name: "EXAMPLE" } },
      ],
    });
    expect((await get("/api/?version=2.1&last_name=example")).body.result_count).toBe(1);
    expect(() => startService({ providers: [{ number: "1", enumeration_type: "NPI-1" }] })).toThrow("number");
  });

  it("serves an inspector built on the shared UI", async () => {
    const { status, body } = await startService()("/_inspector");
    expect(status).toBe(200);
    expect(body).toContain("inspector-table");
  });
});
