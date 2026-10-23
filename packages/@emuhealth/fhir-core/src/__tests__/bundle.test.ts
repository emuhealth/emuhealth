import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, registerFhirRoutes, seedFromConfig, type FhirResource } from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

// Synthetic records only.
const patient = { resourceType: "Patient", name: [{ family: "Example", given: ["Jamie"] }], gender: "female" };

function createApp() {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, {
    resources: [
      { ...patient, id: "p1", identifier: [{ system: "urn:example:mrn", value: "1001" }] },
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { text: "Heart rate" },
        subject: { reference: "Patient/p1" },
      },
    ],
  });
  return app;
}

function post(app: Hono, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return app.request(`${base}/`, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(app: Hono, path: string): Promise<JsonResponse> {
  return app.request(`${base}${path}`);
}

const jsonPatch = (ops: unknown) => ({
  resourceType: "Binary",
  contentType: "application/json-patch+json",
  data: Buffer.from(JSON.stringify(ops)).toString("base64"),
});

describe("fhir-core batch", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("runs entries independently and reports a status for each", async () => {
    const res = await post(app, {
      resourceType: "Bundle",
      type: "batch",
      entry: [
        { resource: patient, request: { method: "POST", url: "Patient" } },
        { request: { method: "GET", url: "Patient/p1" } },
        { request: { method: "GET", url: "Patient/missing" } },
        { request: { method: "GET", url: "Observation?patient=p1" } },
        { request: { method: "DELETE", url: "Observation/o1" } },
      ],
    });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.type).toBe("batch-response");
    expect(bundle.entry.map((e: any) => e.response.status)).toEqual([
      "201 Created",
      "200 OK",
      "404 Not Found",
      "200 OK",
      "204 No Content",
    ]);
    expect(bundle.entry[0].response.location).toMatch(/^http:\/\/localhost:4100\/Patient\/.+\/_history\/1$/);
    expect(bundle.entry[0].response.etag).toBe('W/"1"');
    expect(bundle.entry[1].fullUrl).toBe(`${base}/Patient/p1`);
    expect(bundle.entry[2].response.outcome.resourceType).toBe("OperationOutcome");
    expect(bundle.entry[3].resource.type).toBe("searchset");
    expect(bundle.entry[3].resource.total).toBe(1);
    expect((await get(app, "/Observation/o1")).status).toBe(410);
  });

  it("keeps successful entries when another entry fails", async () => {
    const bundle = await (
      await post(app, {
        resourceType: "Bundle",
        type: "batch",
        entry: [
          { resource: patient, request: { method: "POST", url: "Patient" } },
          { resource: { resourceType: "Spaceship" }, request: { method: "POST", url: "Spaceship" } },
        ],
      })
    ).json();
    expect(bundle.entry[1].response.status).toBe("404 Not Found");
    expect((await (await get(app, "/Patient?family=example")).json()).total).toBe(2);
  });
});

describe("fhir-core transaction", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("creates linked resources and rewrites urn:uuid references", async () => {
    const res = await post(app, {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          fullUrl: "urn:uuid:obs-temp",
          resource: {
            resourceType: "Observation",
            status: "final",
            code: { text: "Body temperature" },
            subject: { reference: "urn:uuid:patient-temp" },
          },
          request: { method: "POST", url: "Observation" },
        },
        { fullUrl: "urn:uuid:patient-temp", resource: patient, request: { method: "POST", url: "Patient" } },
      ],
    });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.type).toBe("transaction-response");
    const patientId = bundle.entry[1].resource.id;
    expect(bundle.entry[0].resource.subject.reference).toBe(`Patient/${patientId}`);
    const linked = await (await get(app, `/Observation?patient=${patientId}`)).json();
    expect(linked.total).toBe(1);
  });

  it("applies deletes before creates, then updates, then reads, and answers in request order", async () => {
    const bundle = await (
      await post(app, {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          { request: { method: "GET", url: "Patient/p1" } },
          { resource: { ...patient, id: "p1", gender: "other" }, request: { method: "PUT", url: "Patient/p1" } },
          { request: { method: "DELETE", url: "Observation/o1" } },
          { resource: patient, request: { method: "POST", url: "Patient" } },
        ],
      })
    ).json();
    expect(bundle.entry.map((e: any) => e.response.status)).toEqual([
      "200 OK",
      "200 OK",
      "204 No Content",
      "201 Created",
    ]);
    // The read ran after the update.
    expect(bundle.entry[0].resource.gender).toBe("other");
    expect(bundle.entry[0].response.etag).toBe('W/"2"');
  });

  it("rolls back every change when an entry fails", async () => {
    const res = await post(app, {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { resource: patient, request: { method: "POST", url: "Patient" } },
        { request: { method: "DELETE", url: "Observation/o1" } },
        { resource: { ...patient, id: "p1" }, request: { method: "PUT", url: "Patient/p1", ifMatch: 'W/"7"' } },
      ],
    });
    expect(res.status).toBe(412);
    const outcome = await res.json();
    expect(outcome.resourceType).toBe("OperationOutcome");
    expect(outcome.issue[0].diagnostics).toContain("entry[2]");
    expect((await (await get(app, "/Patient")).json()).total).toBe(1);
    expect((await get(app, "/Observation/o1")).status).toBe(200);
    expect((await (await get(app, "/_history")).json()).total).toBe(2);
  });

  it("supports conditional create with ifNoneExist", async () => {
    const bundle = await (
      await post(app, {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            fullUrl: "urn:uuid:maybe-new",
            resource: { ...patient, identifier: [{ system: "urn:example:mrn", value: "1001" }] },
            request: { method: "POST", url: "Patient", ifNoneExist: "identifier=urn:example:mrn|1001" },
          },
          {
            resource: {
              resourceType: "Observation",
              status: "final",
              code: { text: "x" },
              subject: { reference: "urn:uuid:maybe-new" },
            },
            request: { method: "POST", url: "Observation" },
          },
        ],
      })
    ).json();
    expect(bundle.entry[0].response.status).toBe("200 OK");
    expect(bundle.entry[0].resource.id).toBe("p1");
    expect(bundle.entry[1].resource.subject.reference).toBe("Patient/p1");
    expect((await (await get(app, "/Patient")).json()).total).toBe(1);
  });

  it("applies JSON Patch entries sent as Binary resources", async () => {
    const bundle = await (
      await post(app, {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            resource: jsonPatch([{ op: "replace", path: "/gender", value: "unknown" }]),
            request: { method: "PATCH", url: "Patient/p1" },
          },
        ],
      })
    ).json();
    expect(bundle.entry[0].response.status).toBe("200 OK");
    expect((await (await get(app, "/Patient/p1")).json()).gender).toBe("unknown");
  });

  it("rejects two entries that change the same resource, and invalid bundles", async () => {
    const twice = await post(app, {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { request: { method: "DELETE", url: "Patient/p1" } },
        { resource: { ...patient, id: "p1" }, request: { method: "PUT", url: "Patient/p1" } },
      ],
    });
    expect(twice.status).toBe(400);
    expect((await get(app, "/Patient/p1")).status).toBe(200);

    expect((await post(app, { resourceType: "Bundle", type: "collection", entry: [] })).status).toBe(400);
    expect((await post(app, { resourceType: "Patient" })).status).toBe(400);
    expect(
      (await post(app, { resourceType: "Bundle", type: "transaction", entry: [{ resource: patient }] })).status,
    ).toBe(400);
    const empty = await (await post(app, { resourceType: "Bundle", type: "transaction" })).json();
    expect(empty).toMatchObject({ type: "transaction-response", entry: [] });
  });

  it("honors Prefer: return=minimal and accepts absolute entry urls", async () => {
    const bundle = await (
      await post(
        app,
        {
          resourceType: "Bundle",
          type: "transaction",
          entry: [{ resource: patient, request: { method: "POST", url: `${base}/Patient` } }],
        },
        { Prefer: "return=minimal" },
      )
    ).json();
    expect(bundle.entry[0].resource).toBeUndefined();
    expect(bundle.entry[0].response.location).toMatch(/\/Patient\//);
  });

  it("works under a vendor base path", async () => {
    const vendor = new Hono();
    registerFhirRoutes(vendor, new Store(), { baseUrl: "http://localhost:4101", basePath: "/api/FHIR/R4" });
    const res: JsonResponse = await vendor.request("http://localhost:4101/api/FHIR/R4", {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify({
        resourceType: "Bundle",
        type: "batch",
        entry: [{ resource: patient, request: { method: "POST", url: "Patient" } }],
      }),
    });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.entry[0].response.location).toMatch(/^http:\/\/localhost:4101\/api\/FHIR\/R4\/Patient\//);
    expect((bundle.entry[0].resource as FhirResource).resourceType).toBe("Patient");
  });
});
