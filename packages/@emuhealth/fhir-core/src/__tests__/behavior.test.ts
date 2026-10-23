import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig } from "../index.js";

// The FHIR API behaviors every served version must share. Inferno has no base R4B or R5 kit, so this suite is the
// behavior gate for those versions.

const base = "http://localhost:4100";
const VERSIONS = [
  { release: "R4", version: "4.0.1", mime: "" },
  { release: "R4B", version: "4.3.0", mime: "; fhirVersion=4.3" },
  { release: "R5", version: "5.0.0", mime: "; fhirVersion=5.0" },
] as const;

function startService(release: string) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  seedFromConfig(store, base, { fhirVersion: release, generate: { patients: 3, seed: 7 } });
  return async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const res = await app.request(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/fhir+json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  };
}

const json = (value: unknown) => JSON.stringify(value);
const MRN = "urn:example:mrn";

describe.each(VERSIONS)("FHIR $release behavior", ({ release, version, mime }) => {
  it("reports its version", async () => {
    const req = startService(release);
    const meta = await req("/metadata");
    expect(meta.body.fhirVersion).toBe(version);
    expect(meta.headers.get("Content-Type")).toBe(`application/fhir+json${mime}; charset=utf-8`);
    const patient = meta.body.rest[0].resource.find((r: any) => r.type === "Patient");
    expect(patient).toMatchObject({ conditionalCreate: true, conditionalUpdate: true, conditionalDelete: "single" });
  });

  it("creates, reads, versions, patches, and deletes", async () => {
    const req = startService(release);
    const created = await req("/Patient", {
      method: "POST",
      body: json({ resourceType: "Patient", name: [{ family: "Matrix" }] }),
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.headers.get("ETag")).toBe('W/"1"');

    const updated = await req(`/Patient/${id}`, {
      method: "PUT",
      headers: { "If-Match": 'W/"1"' },
      body: json({ resourceType: "Patient", id, name: [{ family: "Matrix" }], gender: "other" }),
    });
    expect(updated.body.meta.versionId).toBe("2");
    const stale = await req(`/Patient/${id}`, {
      method: "PUT",
      headers: { "If-Match": 'W/"1"' },
      body: json({ resourceType: "Patient", id }),
    });
    expect(stale.status).toBe(412);

    const patched = await req(`/Patient/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: json([{ op: "replace", path: "/gender", value: "female" }]),
    });
    expect(patched.body.gender).toBe("female");
    expect((await req(`/Patient/${id}/_history/1`)).body.gender).toBeUndefined();
    expect((await req(`/Patient/${id}/_history`)).body.total).toBe(3);

    expect((await req(`/Patient/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/Patient/${id}`)).status).toBe(410);
    expect((await req("/NotAType/1")).status).toBe(404);
  });

  it("searches with modifiers, includes, chains, and paging", async () => {
    const req = startService(release);
    const patients = await req("/Patient?_count=2&_sort=family");
    expect(patients.body.total).toBe(3);
    expect(patients.body.entry).toHaveLength(2);
    expect(patients.body.link.some((l: any) => l.relation === "next")).toBe(true);

    const pid = patients.body.entry[0].resource.id;
    const family = patients.body.entry[0].resource.name[0].family;
    expect((await req(`/Patient?family:exact=${encodeURIComponent(family)}`)).body.total).toBeGreaterThan(0);
    const obs = await req(`/Observation?patient=${pid}&_include=Observation:patient&_count=5`);
    expect(obs.body.entry.some((e: any) => e.search.mode === "include" && e.resource.id === pid)).toBe(true);
    const chained = await req(`/Observation?patient.family=${encodeURIComponent(family)}&_summary=count`);
    expect(chained.body.total).toBeGreaterThan(0);
    expect((await req(`/Observation?date=ge2000-01-01&patient=${pid}&_summary=count`)).body.total).toBeGreaterThan(0);
    const strict = await req("/Patient?nonsense=1", { headers: { Prefer: "handling=strict" } });
    expect(strict.status).toBe(400);
  });

  it("applies transactions atomically and batches independently", async () => {
    const req = startService(release);
    const ok = await req("/", {
      method: "POST",
      body: json({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            fullUrl: "urn:uuid:p",
            resource: { resourceType: "Patient", name: [{ family: "Tx" }] },
            request: { method: "POST", url: "Patient" },
          },
          {
            resource: { resourceType: "Condition", subject: { reference: "urn:uuid:p" }, code: { text: "Synthetic" } },
            request: { method: "POST", url: "Condition" },
          },
        ],
      }),
    });
    expect(ok.body.type).toBe("transaction-response");
    expect(ok.body.entry[1].resource.subject.reference).toBe(`Patient/${ok.body.entry[0].resource.id}`);

    const before = (await req("/Patient?_summary=count")).body.total;
    const failed = await req("/", {
      method: "POST",
      body: json({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          { resource: { resourceType: "Patient" }, request: { method: "POST", url: "Patient" } },
          { request: { method: "DELETE", url: "Patient/does-not-exist" } },
          { resource: { resourceType: "Patient", id: "x" }, request: { method: "PUT", url: "Patient/y" } },
        ],
      }),
    });
    expect(failed.status).toBe(400);
    expect((await req("/Patient?_summary=count")).body.total).toBe(before);

    const batch = await req("/", {
      method: "POST",
      body: json({
        resourceType: "Bundle",
        type: "batch",
        entry: [
          { request: { method: "GET", url: "Patient/does-not-exist" } },
          { resource: { resourceType: "Patient" }, request: { method: "POST", url: "Patient" } },
        ],
      }),
    });
    expect(batch.body.entry.map((e: any) => e.response.status)).toEqual(["404 Not Found", "201 Created"]);
  });

  it("supports conditional create, update, and delete", async () => {
    const req = startService(release);
    const body = json({ resourceType: "Patient", identifier: [{ system: MRN, value: "m-1" }] });
    expect((await req(`/Patient?identifier=${MRN}|m-1`, { method: "PUT", body })).status).toBe(201);
    expect((await req(`/Patient?identifier=${MRN}|m-1`, { method: "PUT", body })).status).toBe(200);
    expect(
      (await req("/Patient", { method: "POST", headers: { "If-None-Exist": `identifier=${MRN}|m-1` }, body })).status,
    ).toBe(200);
    expect((await req(`/Patient?identifier=${MRN}|m-1`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/Patient?identifier=${MRN}|m-1&_summary=count`)).body.total).toBe(0);
  });

  it("returns a patient's record with $everything", async () => {
    const req = startService(release);
    const pid = (await req("/Patient?_count=1")).body.entry[0].resource.id;
    const everything = await req(`/Patient/${pid}/$everything?_count=500`);
    const types = new Set(everything.body.entry.map((e: any) => e.resource.resourceType));
    expect(types.has("Patient")).toBe(true);
    expect(types.has("Observation")).toBe(true);
    expect(types.has("Encounter")).toBe(true);
  });
});
