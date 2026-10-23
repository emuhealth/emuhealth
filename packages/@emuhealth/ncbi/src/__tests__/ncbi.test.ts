import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { generateArticles, ncbiPlugin, seedFromConfig, type NcbiSeedConfig } from "../index.js";

const base = "http://localhost:4105";
const E = "/entrez/eutils";

function startService(config?: NcbiSeedConfig) {
  const app = new Hono();
  const store = new Store();
  ncbiPlugin.register(app as never, store, new WebhookDispatcher(), base);
  ncbiPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string, init?: RequestInit) => {
    const res = await app.request(`${base}${path}`, init);
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, type, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

describe("synthetic PubMed articles", () => {
  it("are deterministic and use unassigned PMIDs and the DOI test prefix", () => {
    expect(generateArticles({ seed: 4 })).toEqual(generateArticles({ seed: 4 }));
    for (const a of generateArticles()) {
      expect(Number(a.uid)).toBeGreaterThan(99_000_000);
      expect(a.doi).toMatch(/^10\.5555\//);
      expect(a.abstract).toContain("Synthetic abstract");
    }
  });
});

describe("E-utilities", () => {
  it("searches PubMed with field tags, boolean operators, dates, and paging", async () => {
    const get = startService();
    const res = await get(`${E}/esearch.fcgi?db=pubmed&term=metformin[ti]+AND+diabetes&retmode=json&retmax=3`);
    expect(res.body.header).toEqual({ type: "esearch", version: "0.3" });
    const result = res.body.esearchresult;
    expect(Number(result.count)).toBeGreaterThan(3);
    expect(result.idlist).toHaveLength(3);
    const none = (await get(`${E}/esearch.fcgi?db=pubmed&term=zzzqqq&retmode=json`)).body.esearchresult;
    expect(none).toMatchObject({ count: "0", idlist: [] });
    expect(none.warninglist.outputmessages).toEqual(["No items found."]);
    const notBreast = (await get(`${E}/esearch.fcgi?db=pubmed&term=cancer+NOT+breast&retmode=json&retmax=100`)).body
      .esearchresult;
    const lung = (await get(`${E}/esearch.fcgi?db=pubmed&term=lung+cancer&retmode=json&retmax=100`)).body.esearchresult;
    expect(notBreast.count).toBe(lung.count);
    const dated = (await get(`${E}/esearch.fcgi?db=pubmed&term=2020:2021[dp]&retmode=json&retmax=200`)).body
      .esearchresult;
    const summaries = (await get(`${E}/esummary.fcgi?db=pubmed&id=${dated.idlist.join(",")}&retmode=json`)).body.result;
    for (const id of dated.idlist) expect(summaries[id].pubdate).toMatch(/^202[01] /);
    const xml = await get(`${E}/esearch.fcgi?db=pubmed&term=asthma`);
    expect(xml.type).toContain("xml");
    expect(xml.body).toContain("<eSearchResult><Count>");
  });

  it("keeps search history for esummary and efetch", async () => {
    const get = startService();
    const search = (await get(`${E}/esearch.fcgi?db=pubmed&term=asthma&usehistory=y&retmode=json`)).body.esearchresult;
    expect(search.webenv).toMatch(/^MCID_/);
    const summary = (
      await get(`${E}/esummary.fcgi?db=pubmed&WebEnv=${search.webenv}&query_key=1&retmax=2&retmode=json`)
    ).body.result;
    expect(summary.uids).toHaveLength(2);
    expect(summary[summary.uids[0]]).toMatchObject({ authors: expect.any(Array), fulljournalname: expect.any(String) });
  });

  it("fetches PubMed XML and abstracts, including by POST", async () => {
    const get = startService();
    const fetched = await get(`${E}/efetch.fcgi?db=pubmed&id=99000001&retmode=xml`);
    expect(fetched.body).toContain('<PMID Version="1">99000001</PMID>');
    expect(fetched.body).toContain("<AbstractText>");
    const text = await get(`${E}/efetch.fcgi?db=pubmed&id=99000001&rettype=abstract&retmode=text`);
    expect(text.body).toContain("PMID: 99000001");
    const posted = await get(`${E}/efetch.fcgi`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "db=pubmed&id=99000001,99000002&rettype=abstract&retmode=text",
    });
    expect(posted.body).toContain("PMID: 99000002");
  });

  it("serves Gene summaries and links genes to articles", async () => {
    const get = startService();
    const search = (await get(`${E}/esearch.fcgi?db=gene&term=BRCA1[sym]+AND+human[orgn]&retmode=json`)).body;
    expect(search.esearchresult.idlist).toEqual(["672"]);
    const summary = (await get(`${E}/esummary.fcgi?db=gene&id=672,999999&retmode=json`)).body.result;
    expect(summary.uids).toEqual(["672"]);
    expect(summary["672"]).toMatchObject({ name: "BRCA1", chromosome: "17", maplocation: "17q21.31" });
    expect(summary["999999"].error).toBeDefined();
    const link = (await get(`${E}/elink.fcgi?dbfrom=gene&db=pubmed&id=672&retmode=json`)).body;
    expect(link.linksets[0].linksetdbs[0].links.length).toBeGreaterThan(0);
    expect((await get(`${E}/einfo.fcgi?retmode=json`)).body.einforesult.dblist).toEqual(["pubmed", "gene"]);
  });

  it("reports unknown databases like E-utilities and can start without articles", async () => {
    const get = startService({ generate: false });
    expect((await get(`${E}/esearch.fcgi?db=nope&term=x&retmode=json`)).body.esearchresult.ERROR).toContain("nope");
    expect((await get(`${E}/esearch.fcgi?db=pubmed&term=asthma&retmode=json`)).body.esearchresult.count).toBe("0");
    expect((await get(`${E}/esearch.fcgi?db=gene&term=TP53&retmode=json`)).body.esearchresult.idlist).toEqual(["7157"]);
  });

  it("serves an inspector built on the shared UI", async () => {
    const res = await startService()("/_inspector?tab=gene");
    expect(res.status).toBe(200);
    expect(res.body).toContain("inspector-table");
    expect(res.body).toContain("BRCA1");
  });
});
