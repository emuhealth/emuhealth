import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { rxnavPlugin, seedFromConfig, type RxNavSeedConfig } from "../index.js";

const base = "http://localhost:4103";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function startService(config?: RxNavSeedConfig) {
  const app = new Hono();
  const store = new Store();
  rxnavPlugin.register(app as never, store, new WebhookDispatcher(), base);
  rxnavPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string) => {
    const res = (await app.request(`${base}${path}`)) as JsonResponse;
    return { status: res.status, body: path.startsWith("/_inspector") ? await res.text() : await res.json() };
  };
}

describe("RxNav REST API", () => {
  it("finds rxcuis by name, with or without .json", async () => {
    const get = startService();
    expect((await get("/REST/rxcui.json?name=lisinopril")).body).toEqual({
      idGroup: { name: "lisinopril", rxnormId: ["29046"] },
    });
    expect((await get("/REST/rxcui?name=Lisinopril")).body.idGroup.rxnormId).toEqual(["29046"]);
    expect((await get("/REST/rxcui.json?name=nothing")).body).toEqual({ idGroup: {} });
  });

  it("returns properties, related concepts, and drugs", async () => {
    const get = startService();
    expect((await get("/REST/rxcui/314076/properties.json")).body.properties).toMatchObject({
      rxcui: "314076",
      name: "lisinopril 10 MG Oral Tablet",
      tty: "SCD",
      language: "ENG",
    });
    expect((await get("/REST/rxcui/0/properties.json")).body).toEqual({});
    const related = (await get("/REST/rxcui/314076/related.json?tty=IN+SBD")).body.relatedGroup;
    expect(related.conceptGroup).toEqual([
      { tty: "IN", conceptProperties: [expect.objectContaining({ rxcui: "29046", name: "lisinopril" })] },
      { tty: "SBD" },
    ]);
    const all = (await get("/REST/rxcui/29046/allrelated.json")).body.allRelatedGroup;
    const scd = all.conceptGroup.find((g: { tty: string }) => g.tty === "SCD");
    expect(scd.conceptProperties[0].rxcui).toBe("314076");
    const drugs = (await get("/REST/drugs.json?name=metformin")).body.drugGroup;
    expect(drugs.conceptGroup.find((g: { tty: string }) => g.tty === "SCD").conceptProperties[0].rxcui).toBe("861007");
    expect((await get("/REST/rxcui/314076/ndcs.json")).body).toEqual({ ndcGroup: { rxcui: "314076", ndcList: {} } });
  });

  it("matches approximate terms and suggests spellings", async () => {
    const get = startService();
    const approx = (await get("/REST/approximateTerm.json?term=lisinoprel&maxEntries=2")).body.approximateGroup;
    expect(approx.candidate[0]).toMatchObject({ rxcui: "29046", rank: "1", source: "RXNORM" });
    expect(approx.candidate.length).toBeLessThanOrEqual(2);
    expect((await get("/REST/spellingsuggestions.json?name=sertralin")).body.suggestionGroup.suggestionList).toEqual({
      suggestion: ["sertraline"],
    });
  });

  it("loads your concepts and can start without the subset", async () => {
    const get = startService({
      defaults: false,
      concepts: [
        { rxcui: "900001", name: "examplemab", tty: "IN" },
        { rxcui: "900002", name: "examplemab 10 MG Injection", tty: "SCD", ingredients: ["900001"] },
      ],
    });
    expect((await get("/REST/rxcui.json?name=lisinopril")).body).toEqual({ idGroup: {} });
    const drugs = (await get("/REST/drugs.json?name=examplemab")).body.drugGroup;
    expect(drugs.conceptGroup.find((g: { tty: string }) => g.tty === "SCD").conceptProperties[0].rxcui).toBe("900002");
    expect(() => startService({ concepts: [{ rxcui: "x", name: "y", tty: "IN" }] })).toThrow("rxcui");
    expect(() => startService({ concepts: [{ rxcui: "1", name: "y", tty: "NOPE" }] })).toThrow("tty");
  });

  it("serves an inspector built on the shared UI", async () => {
    const get = startService();
    const { status, body } = await get("/_inspector");
    expect(status).toBe(200);
    expect(body).toContain("inspector-table");
    expect(body).toContain("sertraline 50 MG Oral Tablet");
  });
});
