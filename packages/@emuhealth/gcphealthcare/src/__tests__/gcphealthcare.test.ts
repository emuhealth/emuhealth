import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { gcphealthcarePlugin, seedFromConfig, type GcpHealthcareSeedConfig } from "../index.js";

const origin = "http://localhost:4115";
const LOC = "/v1/projects/synthetic-project/locations/us-central1";
const STORE = `${LOC}/datasets/synthetic-dataset/fhirStores/synthetic-fhir-store`;

function startService(config?: GcpHealthcareSeedConfig) {
  const app = new Hono();
  const store = new Store();
  gcphealthcarePlugin.register(app as never, store, new WebhookDispatcher(), origin);
  gcphealthcarePlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  return async (method: string, path: string, body?: unknown, contentType = "application/json") => {
    const res = await app.request(`${origin}${path}`, {
      method,
      headers: { Authorization: "Bearer ya29.synthetic", ...(body ? { "Content-Type": contentType } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

describe("Cloud Healthcare API", () => {
  it("needs an OAuth token and returns Google error shapes", async () => {
    const app = new Hono();
    const store = new Store();
    gcphealthcarePlugin.register(app as never, store, new WebhookDispatcher(), origin);
    gcphealthcarePlugin.seed?.(store, origin);
    const res = await app.request(`${origin}${LOC}/datasets`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.status).toBe("UNAUTHENTICATED");
    const call = startService();
    expect((await call("GET", `${LOC}/datasets/missing`)).body.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
  });

  it("creates datasets as operations and manages FHIR stores", async () => {
    const call = startService();
    const op = await call("POST", `${LOC}/datasets?datasetId=mine`, { timeZone: "UTC" });
    expect(op.body).toMatchObject({
      done: true,
      response: { name: "projects/synthetic-project/locations/us-central1/datasets/mine" },
    });
    expect((await call("GET", `/v1/${op.body.name}`)).body.done).toBe(true);
    expect((await call("POST", `${LOC}/datasets?datasetId=mine`, {})).status).toBe(409);
    const list = await call("GET", `${LOC}/datasets`);
    expect(list.body.datasets.map((d: { name: string }) => d.name.split("/").pop()).sort()).toEqual([
      "mine",
      "synthetic-dataset",
    ]);
    const created = await call("POST", `${LOC}/datasets/mine/fhirStores?fhirStoreId=store1`, {
      version: "R4",
      enableUpdateCreate: false,
    });
    expect(created.body).toMatchObject({ version: "R4", enableUpdateCreate: false });
    expect((await call("POST", `${LOC}/datasets/mine/fhirStores?fhirStoreId=store2`, { version: "STU3" })).status).toBe(
      400,
    );
    const patched = await call("PATCH", `${LOC}/datasets/mine/fhirStores/store1?updateMask=enableUpdateCreate`, {
      enableUpdateCreate: true,
    });
    expect(patched.body.enableUpdateCreate).toBe(true);
    expect(
      (await call("POST", `${LOC}/datasets/mine/fhirStores/store1:export`, { gcsDestination: { uriPrefix: "gs://x" } }))
        .body.done,
    ).toBe(true);
    expect((await call("DELETE", `${LOC}/datasets/mine/fhirStores/store1`)).status).toBe(200);
    expect((await call("GET", `${LOC}/datasets/mine/fhirStores/store1`)).status).toBe(404);
  });

  it("serves FHIR per store, honoring enableUpdateCreate", async () => {
    const call = startService();
    const patient = await call("GET", `${STORE}/fhir/Patient/syn-patient-001`);
    expect(patient.body.id).toBe("syn-patient-001");
    await call("POST", `${LOC}/datasets/synthetic-dataset/fhirStores?fhirStoreId=strict`, { version: "R4" });
    const strict = `${LOC}/datasets/synthetic-dataset/fhirStores/strict/fhir`;
    expect((await call("GET", `${strict}/Patient/syn-patient-001`)).status).toBe(404);
    const put = await call(
      "PUT",
      `${strict}/Patient/p1`,
      { resourceType: "Patient", id: "p1" },
      "application/fhir+json",
    );
    expect(put.status).toBe(404);
    expect(put.body.resourceType).toBe("OperationOutcome");
    const post = await call("POST", `${strict}/Patient`, { resourceType: "Patient" }, "application/fhir+json");
    expect(post.status).toBe(201);
    const putCreate = await call(
      "PUT",
      `${STORE}/fhir/Patient/new-one`,
      { resourceType: "Patient", id: "new-one" },
      "application/fhir+json",
    );
    expect(putCreate.status).toBe(201);
  });

  it("takes configured datasets", async () => {
    const call = startService({
      datasets: [{ project: "p", location: "europe-west4", id: "d", fhirStores: [{ id: "s", preload: true }] }],
    });
    expect((await call("GET", `${LOC}/datasets`)).body.datasets).toEqual([]);
    expect(
      (await call("GET", "/v1/projects/p/locations/europe-west4/datasets/d/fhirStores/s/fhir/Patient/syn-patient-002"))
        .status,
    ).toBe(200);
    expect(() => startService({ datasets: [{ project: "p", location: "l" } as never] })).toThrow("id is required");
  });
});
