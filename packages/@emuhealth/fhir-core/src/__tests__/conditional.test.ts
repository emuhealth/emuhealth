import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin } from "../index.js";

const base = "http://localhost:4100";
const MRN = "urn:example:mrn";

function startService() {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/fhir+json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  };
  return req;
}

const patient = (mrn: string, family: string, extra: Record<string, unknown> = {}) => ({
  resourceType: "Patient",
  identifier: [{ system: MRN, value: mrn }],
  name: [{ family }],
  ...extra,
});

describe("conditional interactions", () => {
  it("creates only when nothing matches If-None-Exist", async () => {
    const req = startService();
    const first = await req("/Patient", {
      method: "POST",
      headers: { "If-None-Exist": `identifier=${MRN}|c-1` },
      body: JSON.stringify(patient("c-1", "First")),
    });
    expect(first.status).toBe(201);
    const again = await req("/Patient", {
      method: "POST",
      headers: { "If-None-Exist": `identifier=${MRN}|c-1` },
      body: JSON.stringify(patient("c-1", "Second")),
    });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.name[0].family).toBe("First");

    await req("/Patient", { method: "POST", body: JSON.stringify(patient("c-1", "Duplicate")) });
    const many = await req("/Patient", {
      method: "POST",
      headers: { "If-None-Exist": `identifier=${MRN}|c-1` },
      body: JSON.stringify(patient("c-1", "Third")),
    });
    expect(many.status).toBe(412);
    expect(many.body.issue[0].code).toBe("multiple-matches");
  });

  it("updates the one match, creates on no match, and rejects ambiguity", async () => {
    const req = startService();
    const created = await req(`/Patient?identifier=${MRN}|u-1`, {
      method: "PUT",
      body: JSON.stringify(patient("u-1", "New")),
    });
    expect(created.status).toBe(201);
    const updated = await req(`/Patient?identifier=${MRN}|u-1`, {
      method: "PUT",
      body: JSON.stringify(patient("u-1", "Renamed")),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.meta.versionId).toBe("2");

    const wrongId = await req(`/Patient?identifier=${MRN}|u-1`, {
      method: "PUT",
      body: JSON.stringify(patient("u-1", "X", { id: "someone-else" })),
    });
    expect(wrongId.status).toBe(400);

    const withId = await req(`/Patient?identifier=${MRN}|u-2`, {
      method: "PUT",
      body: JSON.stringify(patient("u-2", "Chosen", { id: "chosen-id" })),
    });
    expect(withId.status).toBe(201);
    expect(withId.body.id).toBe("chosen-id");

    expect((await req("/Patient", { method: "PUT", body: JSON.stringify(patient("u-3", "X")) })).status).toBe(400);
    expect(
      (await req("/Patient?family=Renamed,Chosen", { method: "PUT", body: JSON.stringify(patient("u-4", "X")) }))
        .status,
    ).toBe(412);
  });

  it("deletes the one match and treats no match as done", async () => {
    const req = startService();
    const created = await req("/Patient", { method: "POST", body: JSON.stringify(patient("d-1", "Gone")) });
    expect((await req(`/Patient?identifier=${MRN}|d-1`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/Patient/${created.body.id}`)).status).toBe(410);
    expect((await req(`/Patient?identifier=${MRN}|d-1`, { method: "DELETE" })).status).toBe(204);
  });

  it("answers If-Modified-Since and If-None-Match with 304", async () => {
    const req = startService();
    const created = await req("/Patient", { method: "POST", body: JSON.stringify(patient("r-1", "Read")) });
    const id = created.body.id;
    const later = new Date(Date.now() + 60_000).toUTCString();
    const earlier = new Date(Date.now() - 60_000).toUTCString();
    expect((await req(`/Patient/${id}`, { headers: { "If-Modified-Since": later } })).status).toBe(304);
    expect((await req(`/Patient/${id}`, { headers: { "If-Modified-Since": earlier } })).status).toBe(200);
    expect((await req(`/Patient/${id}`, { headers: { "If-None-Match": 'W/"1"' } })).status).toBe(304);
  });

  it("runs conditional entries in transactions and resolves their fullUrls", async () => {
    const req = startService();
    const tx = (mrn: string, family: string) =>
      req("/", {
        method: "POST",
        body: JSON.stringify({
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              fullUrl: "urn:uuid:patient",
              resource: patient(mrn, family),
              request: { method: "PUT", url: `Patient?identifier=${MRN}|${mrn}` },
            },
            {
              fullUrl: "urn:uuid:obs",
              resource: {
                resourceType: "Observation",
                status: "final",
                code: { text: "Pulse" },
                subject: { reference: "urn:uuid:patient" },
              },
              request: { method: "POST", url: "Observation" },
            },
          ],
        }),
      });
    const first = await tx("t-1", "Tx");
    expect(first.status).toBe(200);
    expect(first.body.entry[0].response.status).toBe("201 Created");
    const patientId = first.body.entry[0].resource.id;
    expect(first.body.entry[1].resource.subject.reference).toBe(`Patient/${patientId}`);

    const second = await tx("t-1", "Tx Renamed");
    expect(second.body.entry[0].response.status).toBe("200 OK");
    expect(second.body.entry[0].resource.id).toBe(patientId);
    expect(second.body.entry[1].resource.subject.reference).toBe(`Patient/${patientId}`);

    const batch = await req("/", {
      method: "POST",
      body: JSON.stringify({
        resourceType: "Bundle",
        type: "batch",
        entry: [
          { request: { method: "DELETE", url: `Patient?identifier=${MRN}|t-1` } },
          {
            resource: patient("t-2", "Batch"),
            request: { method: "POST", url: "Patient", ifNoneExist: `identifier=${MRN}|t-2` },
          },
        ],
      }),
    });
    expect(batch.body.entry.map((e: any) => e.response.status)).toEqual(["204 No Content", "201 Created"]);
  });
});

describe("conditional criteria", () => {
  it("matches Observations by identifier and rejects unknown criteria", async () => {
    const req = startService();
    const obs = {
      resourceType: "Observation",
      status: "final",
      code: { text: "x" },
      identifier: [{ system: "urn:example:obs", value: "o-1" }],
    };
    const first = await req("/Observation", {
      method: "POST",
      headers: { "If-None-Exist": "identifier=urn:example:obs|o-1" },
      body: JSON.stringify(obs),
    });
    expect(first.status).toBe(201);
    const again = await req("/Observation", {
      method: "POST",
      headers: { "If-None-Exist": "identifier=urn:example:obs|o-1" },
      body: JSON.stringify(obs),
    });
    expect(again.status).toBe(200);
    const unknown = await req("/Observation", {
      method: "POST",
      headers: { "If-None-Exist": "nonsense=1" },
      body: JSON.stringify(obs),
    });
    expect(unknown.status).toBe(400);
  });
});
