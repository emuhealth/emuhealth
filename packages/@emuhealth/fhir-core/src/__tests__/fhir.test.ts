import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, registerFhirRoutes, seedFromConfig, applyJsonPatch, FhirError } from "../index.js";

const base = "http://localhost:4100";
const FHIR = "application/fhir+json";

// Response bodies are FHIR JSON; tests read them loosely.
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

const patient = {
  resourceType: "Patient",
  name: [{ family: "Example", given: ["Jamie"] }],
  gender: "female",
  birthDate: "1980-01-01",
};

function createApp(store = new Store()) {
  const app = new Hono();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  return { app, store };
}

function send(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return app.request(`${base}${path}`, {
    method,
    headers: { "Content-Type": FHIR, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createPatient(app: Hono) {
  const res = await send(app, "POST", "/Patient", patient);
  return (await res.json()) as { id: string; meta: { versionId: string; lastUpdated: string } };
}

describe("fhir-core create and read", () => {
  let app: Hono;
  beforeEach(() => ({ app } = createApp()));

  it("creates a resource with a server id, version 1, and FHIR headers", async () => {
    const res = await send(app, "POST", "/Patient", { ...patient, id: "ignored" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toContain("application/fhir+json");
    const body = await res.json();
    expect(body.id).not.toBe("ignored");
    expect(body.meta.versionId).toBe("1");
    expect(res.headers.get("ETag")).toBe('W/"1"');
    expect(res.headers.get("Location")).toBe(`${base}/Patient/${body.id}/_history/1`);
    expect(res.headers.get("Last-Modified")).toBeTruthy();
  });

  it("reads the current version and honors If-None-Match", async () => {
    const created = await createPatient(app);
    const res = await send(app, "GET", `/Patient/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).name[0].family).toBe("Example");
    const notModified = await send(app, "GET", `/Patient/${created.id}`, undefined, { "If-None-Match": 'W/"1"' });
    expect(notModified.status).toBe(304);
  });

  it("returns OperationOutcome errors for unknown ids, unknown types, and bad bodies", async () => {
    const missing = await send(app, "GET", "/Patient/does-not-exist");
    expect(missing.status).toBe(404);
    expect((await missing.json()).issue[0].code).toBe("not-found");

    const unknownType = await send(app, "POST", "/Spaceship", { resourceType: "Spaceship" });
    expect(unknownType.status).toBe(404);
    expect((await unknownType.json()).issue[0].code).toBe("not-supported");

    const mismatch = await send(app, "POST", "/Patient", { resourceType: "Observation" });
    expect(mismatch.status).toBe(400);

    const badJson: JsonResponse = await app.request(`${base}/Patient`, {
      method: "POST",
      headers: { "Content-Type": FHIR },
      body: "{",
    });
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).resourceType).toBe("OperationOutcome");

    const xml = await send(app, "POST", "/Patient", patient, { "Content-Type": "application/fhir+xml" });
    expect(xml.status).toBe(415);
  });

  it("supports Prefer return=minimal", async () => {
    const res = await send(app, "POST", "/Patient", patient, { Prefer: "return=minimal" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Location")).toMatch(/\/Patient\/.+\/_history\/1$/);
  });
});

describe("fhir-core update, patch, and delete", () => {
  let app: Hono;
  beforeEach(() => ({ app } = createApp()));

  it("updates with a new version and keeps old versions for vread", async () => {
    const created = await createPatient(app);
    const res = await send(app, "PUT", `/Patient/${created.id}`, { ...patient, id: created.id, gender: "other" });
    expect(res.status).toBe(200);
    expect((await res.json()).meta.versionId).toBe("2");
    expect(res.headers.get("ETag")).toBe('W/"2"');

    const v1 = await send(app, "GET", `/Patient/${created.id}/_history/1`);
    expect(v1.status).toBe(200);
    expect((await v1.json()).gender).toBe("female");
  });

  it("creates on update when the id does not exist", async () => {
    const res = await send(app, "PUT", "/Patient/synthetic-1", { ...patient, id: "synthetic-1" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`${base}/Patient/synthetic-1/_history/1`);
  });

  it("rejects updates whose body id is missing or different", async () => {
    expect((await send(app, "PUT", "/Patient/a", patient)).status).toBe(400);
    expect((await send(app, "PUT", "/Patient/a", { ...patient, id: "b" })).status).toBe(400);
  });

  it("enforces If-Match on update, patch, and delete", async () => {
    const created = await createPatient(app);
    const stale = await send(
      app,
      "PUT",
      `/Patient/${created.id}`,
      { ...patient, id: created.id },
      { "If-Match": 'W/"9"' },
    );
    expect(stale.status).toBe(412);
    expect((await stale.json()).issue[0].code).toBe("conflict");

    const ok = await send(
      app,
      "PUT",
      `/Patient/${created.id}`,
      { ...patient, id: created.id },
      { "If-Match": 'W/"1"' },
    );
    expect(ok.status).toBe(200);

    const patchStale = await send(app, "PATCH", `/Patient/${created.id}`, [], {
      "Content-Type": "application/json-patch+json",
      "If-Match": 'W/"1"',
    });
    expect(patchStale.status).toBe(412);

    const deleteStale = await send(app, "DELETE", `/Patient/${created.id}`, undefined, { "If-Match": 'W/"1"' });
    expect(deleteStale.status).toBe(412);
  });

  it("applies JSON Patch and rejects id changes and other content types", async () => {
    const created = await createPatient(app);
    const patchHeaders = { "Content-Type": "application/json-patch+json" };
    const res = await send(
      app,
      "PATCH",
      `/Patient/${created.id}`,
      [
        { op: "test", path: "/gender", value: "female" },
        { op: "replace", path: "/gender", value: "unknown" },
        { op: "add", path: "/name/0/given/-", value: "Lee" },
      ],
      patchHeaders,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gender).toBe("unknown");
    expect(body.name[0].given).toEqual(["Jamie", "Lee"]);
    expect(body.meta.versionId).toBe("2");

    const changeId = await send(
      app,
      "PATCH",
      `/Patient/${created.id}`,
      [{ op: "replace", path: "/id", value: "x" }],
      patchHeaders,
    );
    expect(changeId.status).toBe(400);

    const failedTest = await send(
      app,
      "PATCH",
      `/Patient/${created.id}`,
      [{ op: "test", path: "/gender", value: "male" }],
      patchHeaders,
    );
    expect(failedTest.status).toBe(422);

    expect((await send(app, "PATCH", `/Patient/${created.id}`, [])).status).toBe(415);
  });

  it("deletes logically, returns 410 afterwards, and continues versions on re-create", async () => {
    const created = await createPatient(app);
    const del = await send(app, "DELETE", `/Patient/${created.id}`);
    expect(del.status).toBe(204);
    expect(del.headers.get("ETag")).toBe('W/"2"');

    const gone = await send(app, "GET", `/Patient/${created.id}`);
    expect(gone.status).toBe(410);
    expect((await gone.json()).issue[0].code).toBe("deleted");
    expect((await send(app, "GET", `/Patient/${created.id}/_history/2`)).status).toBe(410);
    expect((await send(app, "GET", `/Patient/${created.id}/_history/1`)).status).toBe(200);

    expect((await send(app, "DELETE", `/Patient/${created.id}`)).status).toBe(204);
    expect((await send(app, "DELETE", "/Patient/never-existed")).status).toBe(204);

    const recreated = await send(app, "PUT", `/Patient/${created.id}`, { ...patient, id: created.id });
    expect(recreated.status).toBe(201);
    expect((await recreated.json()).meta.versionId).toBe("3");
  });
});

describe("fhir-core history", () => {
  let app: Hono;
  beforeEach(() => ({ app } = createApp()));

  it("returns instance, type, and system history bundles newest first", async () => {
    const created = await createPatient(app);
    await send(app, "PUT", `/Patient/${created.id}`, { ...patient, id: created.id, gender: "other" });
    await send(app, "DELETE", `/Patient/${created.id}`);
    await send(app, "POST", "/Observation", {
      resourceType: "Observation",
      status: "final",
      code: { text: "Heart rate" },
    });

    const instance = await (await send(app, "GET", `/Patient/${created.id}/_history`)).json();
    expect(instance.resourceType).toBe("Bundle");
    expect(instance.type).toBe("history");
    expect(instance.total).toBe(3);
    expect(instance.entry.map((e: { request: { method: string } }) => e.request.method)).toEqual([
      "DELETE",
      "PUT",
      "POST",
    ]);
    expect(instance.entry[0].resource).toBeUndefined();
    expect(instance.entry[1].response.etag).toBe('W/"2"');
    expect(instance.entry[2].fullUrl).toBe(`${base}/Patient/${created.id}`);

    const type = await (await send(app, "GET", "/Observation/_history")).json();
    expect(type.total).toBe(1);

    const system = await (await send(app, "GET", "/_history?_count=2")).json();
    expect(system.total).toBe(4);
    expect(system.entry).toHaveLength(2);
    expect(system.entry[0].resource.resourceType).toBe("Observation");
  });

  it("filters with _since and validates parameters", async () => {
    await createPatient(app);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await (await send(app, "GET", `/_history?_since=${future}`)).json()).total).toBe(0);
    expect((await send(app, "GET", "/_history?_since=yesterday")).status).toBe(400);
    expect((await send(app, "GET", "/_history?_count=many")).status).toBe(400);
    expect((await send(app, "GET", "/Patient/unknown/_history")).status).toBe(404);
  });
});

describe("fhir-core library use", () => {
  it("mounts under a vendor base path", async () => {
    const app = new Hono();
    registerFhirRoutes(app, new Store(), { baseUrl: "http://localhost:4101", basePath: "/api/FHIR/R4" });
    const res = await app.request("http://localhost:4101/api/FHIR/R4/Patient", {
      method: "POST",
      headers: { "Content-Type": FHIR },
      body: JSON.stringify(patient),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toMatch(/^http:\/\/localhost:4101\/api\/FHIR\/R4\/Patient\//);
    expect((await app.request("http://localhost:4101/Patient")).status).toBe(404);
  });

  it("seeds synthetic resources from config, keeping explicit ids", async () => {
    const { app, store } = createApp();
    seedFromConfig(store, base, { resources: [{ ...patient, id: "seeded" }, { resourceType: "Practitioner" }] });
    expect((await send(app, "GET", "/Patient/seeded")).status).toBe(200);
    expect((await (await send(app, "GET", "/Practitioner/_history")).json()).total).toBe(1);
    expect(() => seedFromConfig(store, base, { resources: [{ resourceType: "Nope" }] })).toThrow("fhir.resources[0]");
  });

  it("resets with the core store", async () => {
    const { app, store } = createApp();
    const created = await createPatient(app);
    store.reset();
    expect((await send(app, "GET", `/Patient/${created.id}`)).status).toBe(404);
  });
});

describe("applyJsonPatch", () => {
  const doc = { a: { b: [1, 2] }, c: "x" };

  it("supports add, remove, replace, move, copy, and test", () => {
    expect(
      applyJsonPatch(doc, [
        { op: "add", path: "/a/b/1", value: 9 },
        { op: "remove", path: "/c" },
        { op: "copy", from: "/a/b", path: "/d" },
        { op: "move", from: "/d", path: "/e" },
        { op: "replace", path: "/a/b/0", value: 0 },
        { op: "test", path: "/e", value: [1, 9, 2] },
      ]),
    ).toEqual({ a: { b: [0, 9, 2] }, e: [1, 9, 2] });
    expect(doc).toEqual({ a: { b: [1, 2] }, c: "x" });
  });

  it("rejects invalid operations", () => {
    expect(() => applyJsonPatch(doc, {})).toThrow(FhirError);
    expect(() => applyJsonPatch(doc, [{ op: "remove", path: "/missing" }])).toThrow("does not exist");
    expect(() => applyJsonPatch(doc, [{ op: "add", path: "/a/b/7", value: 1 }])).toThrow("out of range");
    expect(() => applyJsonPatch(doc, [{ op: "move", from: "/a", path: "/a/z" }])).toThrow("children");
  });
});
