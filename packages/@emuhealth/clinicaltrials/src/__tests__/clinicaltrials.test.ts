import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { clinicaltrialsPlugin, generateStudies, seedFromConfig, type ClinicalTrialsSeedConfig } from "../index.js";

const base = "http://localhost:4104";

function startService(config?: ClinicalTrialsSeedConfig) {
  const app = new Hono();
  const store = new Store();
  clinicaltrialsPlugin.register(app as never, store, new WebhookDispatcher(), base);
  clinicaltrialsPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string) => {
    const res = await app.request(`${base}${path}`);
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

describe("generated studies", () => {
  it("are deterministic and use the unassigned NCT99 range", () => {
    expect(generateStudies({ seed: 2 })).toEqual(generateStudies({ seed: 2 }));
    const studies = generateStudies() as any[];
    expect(studies).toHaveLength(60);
    for (const s of studies) expect(s.protocolSection.identificationModule.nctId).toMatch(/^NCT99\d{6}$/);
  });
});

describe("ClinicalTrials.gov API v2", () => {
  it("searches studies with queries, filters, and page tokens", async () => {
    const get = startService();
    const first = await get("/api/v2/studies?query.cond=asthma&pageSize=3&countTotal=true");
    expect(first.status).toBe(200);
    expect(first.body.totalCount).toBeGreaterThan(3);
    expect(first.body.studies).toHaveLength(3);
    for (const s of first.body.studies) expect(s.protocolSection.conditionsModule.conditions).toContain("Asthma");
    const second = await get(`/api/v2/studies?query.cond=asthma&pageSize=3&pageToken=${first.body.nextPageToken}`);
    expect(second.body.studies[0].protocolSection.identificationModule.nctId).not.toBe(
      first.body.studies[0].protocolSection.identificationModule.nctId,
    );
    const recruiting = await get("/api/v2/studies?filter.overallStatus=RECRUITING&pageSize=100");
    for (const s of recruiting.body.studies) expect(s.protocolSection.statusModule.overallStatus).toBe("RECRUITING");
    const byId = await get("/api/v2/studies?filter.ids=NCT99000001,NCT99000002");
    expect(byId.body.studies).toHaveLength(2);
    const advanced = await get("/api/v2/studies?filter.advanced=AREA[StudyType]OBSERVATIONAL&pageSize=100");
    for (const s of advanced.body.studies) expect(s.protocolSection.designModule.studyType).toBe("OBSERVATIONAL");
    const located = await get("/api/v2/studies?query.locn=Springfield&pageSize=100");
    expect(located.body.studies.length).toBeGreaterThan(0);
  });

  it("selects fields and sorts", async () => {
    const get = startService();
    const res = await get("/api/v2/studies?fields=NCTId,OverallStatus,LocationCity&sort=StartDate:desc&pageSize=1");
    expect(Object.keys(res.body.studies[0])).toEqual(["protocolSection"]);
    const section = res.body.studies[0].protocolSection;
    expect(Object.keys(section).sort()).toEqual(["contactsLocationsModule", "identificationModule", "statusModule"]);
    expect(Object.keys(section.contactsLocationsModule.locations[0])).toEqual(["city"]);
    const dates = (await get("/api/v2/studies?fields=StartDate&sort=StartDate:desc&pageSize=20")).body.studies.map(
      (s: any) => s.protocolSection.statusModule.startDateStruct.date,
    );
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("returns single studies and plain text errors like the real API", async () => {
    const get = startService();
    const study = await get("/api/v2/studies/NCT99000001");
    expect(study.body.protocolSection.identificationModule.nctId).toBe("NCT99000001");
    expect(await get("/api/v2/studies/NCT00000000")).toEqual({ status: 404, body: "NCT number NCT00000000 not found" });
    expect(await get("/api/v2/studies/123")).toEqual({ status: 400, body: "Parameter `nctId` has incorrect format" });
    expect((await get("/api/v2/studies?filter.overallStatus=BOGUS")).status).toBe(400);
    expect((await get("/api/v2/studies?fields=Bogus")).body).toBe(
      "Parameter 'fields' contains invalid field name: 'Bogus'",
    );
    expect((await get("/api/v2/version")).body.apiVersion).toBe("2.0.5");
    expect((await get("/api/v2/stats/size")).body.totalStudies).toBe(60);
  });

  it("loads your studies and can start empty", async () => {
    const get = startService({
      generate: false,
      studies: [
        { protocolSection: { identificationModule: { nctId: "NCT99999999", briefTitle: "My synthetic study" } } },
      ],
    });
    expect((await get("/api/v2/studies?countTotal=true")).body.totalCount).toBe(1);
    expect((await get("/api/v2/studies?query.titles=my+synthetic")).body.studies).toHaveLength(1);
    expect(() => startService({ studies: [{ protocolSection: {} }] })).toThrow("nctId");
  });

  it("serves an inspector built on the shared UI", async () => {
    const { status, body } = await startService()("/_inspector");
    expect(status).toBe(200);
    expect(body).toContain("inspector-table");
    expect(body).toContain("NCT99000001");
  });
});
