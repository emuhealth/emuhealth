import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import { fhirPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:14000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(new Map()));
  fhirPlugin.register(app as any, store, webhooks, base);
  seedFromConfig(store, base, {
    resources: [
      {
        resourceType: "Patient",
        id: "pat-001",
        name: [{ family: "Rivera", given: ["Avery"] }],
      },
      {
        resourceType: "Observation",
        id: "obs-001",
        status: "final",
        subject: { reference: "Patient/pat-001" },
      },
    ],
  });
  return { app };
}

describe("FHIR plugin", () => {
  it("serves CapabilityStatement and SMART discovery metadata", async () => {
    const { app } = createTestApp();

    const metadata = await app.request(`${base}/metadata`);
    expect(metadata.status).toBe(200);
    const capability = (await metadata.json()) as { resourceType: string; fhirVersion: string };
    expect(capability.resourceType).toBe("CapabilityStatement");
    expect(capability.fhirVersion).toBe("4.0.1");

    const smart = await app.request(`${base}/.well-known/smart-configuration`);
    expect(smart.status).toBe(200);
    const config = (await smart.json()) as { issuer: string; capabilities: string[] };
    expect(config.issuer).toBe(base);
    expect(config.capabilities).toContain("launch-standalone");
  });

  it("reads and searches seeded resources", async () => {
    const { app } = createTestApp();

    const read = await app.request(`${base}/Patient/pat-001`);
    expect(read.status).toBe(200);
    const patient = (await read.json()) as { id: string; resourceType: string };
    expect(patient).toMatchObject({ id: "pat-001", resourceType: "Patient" });

    const search = await app.request(`${base}/Observation?patient=pat-001`);
    expect(search.status).toBe(200);
    const bundle = (await search.json()) as { resourceType: string; total: number; entry: Array<{ resource: { id: string } }> };
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].resource.id).toBe("obs-001");
  });

  it("creates, updates, and deletes resources", async () => {
    const { app } = createTestApp();

    const create = await app.request(`${base}/Patient`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: [{ family: "Chen" }] }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; resourceType: string; meta: { versionId: string } };
    expect(created.resourceType).toBe("Patient");
    expect(created.meta.versionId).toBe("1");

    const update = await app.request(`${base}/Patient/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceType: "Patient", name: [{ family: "Chen", given: ["Mina"] }] }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { id: string; meta: { versionId: string } };
    expect(updated.id).toBe(created.id);
    expect(updated.meta.versionId).toBe("2");

    const del = await app.request(`${base}/Patient/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const missing = await app.request(`${base}/Patient/${created.id}`);
    expect(missing.status).toBe(404);
  });
});
