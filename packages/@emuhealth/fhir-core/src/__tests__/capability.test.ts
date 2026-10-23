import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, registerFhirRoutes, R4_RESOURCE_TYPES } from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function createApp() {
  const app = new Hono();
  fhirPlugin.register(app as never, new Store(), new WebhookDispatcher(), base);
  return app;
}

describe("fhir-core /metadata", () => {
  it("returns a CapabilityStatement for FHIR 4.0.1 JSON", async () => {
    const res: JsonResponse = await createApp().request(`${base}/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/fhir+json");
    const cs = await res.json();
    expect(cs).toMatchObject({
      resourceType: "CapabilityStatement",
      status: "active",
      kind: "instance",
      fhirVersion: "4.0.1",
      format: ["application/fhir+json", "json"],
      patchFormat: ["application/json-patch+json"],
      implementation: { url: base },
    });
    expect(cs.rest[0].mode).toBe("server");
    expect(cs.rest[0].interaction.map((i: { code: string }) => i.code)).toEqual([
      "transaction",
      "batch",
      "history-system",
    ]);
  });

  it("lists every R4 resource type with its interactions and search parameters", async () => {
    const cs = await ((await createApp().request(`${base}/metadata`)) as JsonResponse).json();
    const resources = cs.rest[0].resource;
    expect(resources).toHaveLength(R4_RESOURCE_TYPES.size);
    const observation = resources.find((r: { type: string }) => r.type === "Observation");
    expect(observation.interaction.map((i: { code: string }) => i.code)).toEqual([
      "read",
      "vread",
      "update",
      "patch",
      "delete",
      "history-instance",
      "history-type",
      "create",
      "search-type",
    ]);
    expect(observation).toMatchObject({ versioning: "versioned-update", updateCreate: true, conditionalCreate: true });
    const params = observation.searchParam.map((p: { name: string; type: string }) => `${p.name}:${p.type}`);
    expect(params).toEqual(
      expect.arrayContaining(["_id:token", "_lastUpdated:date", "patient:reference", "code:token", "date:date"]),
    );
    expect(observation.searchInclude).toEqual(expect.arrayContaining(["Observation:patient", "Observation:subject"]));

    const patient = resources.find((r: { type: string }) => r.type === "Patient");
    expect(patient.searchRevInclude).toEqual(expect.arrayContaining(["Observation:patient", "Condition:patient"]));
    expect(patient.searchRevInclude).not.toContain("Patient:organization");

    const binary = resources.find((r: { type: string }) => r.type === "Binary");
    expect(binary.searchParam.map((p: { name: string }) => p.name)).toEqual(["_id", "_lastUpdated"]);
  });

  it("reports vendor software and description when mounted as a library", async () => {
    const app = new Hono();
    registerFhirRoutes(app, new Store(), {
      baseUrl: "http://localhost:4101",
      basePath: "/api/FHIR/R4",
      software: { name: "Example EHR emulator", version: "1.2.3" },
      description: "Example vendor FHIR API",
    });
    const cs = await ((await app.request("http://localhost:4101/api/FHIR/R4/metadata")) as JsonResponse).json();
    expect(cs.software).toEqual({ name: "Example EHR emulator", version: "1.2.3" });
    expect(cs.implementation).toEqual({
      description: "Example vendor FHIR API",
      url: "http://localhost:4101/api/FHIR/R4",
    });
  });
});

describe("fhir service OperationOutcome for unsupported paths", () => {
  it("answers unknown paths and methods with an OperationOutcome", async () => {
    const app = createApp();
    for (const [method, path] of [
      ["GET", "/patient"],
      ["PATCH", "/Patient"],
      ["PUT", "/metadata"],
    ]) {
      const res: JsonResponse = await app.request(`${base}${path}`, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("application/fhir+json");
      const outcome = await res.json();
      expect(outcome.resourceType).toBe("OperationOutcome");
      expect(outcome.issue[0].code).toBe("not-supported");
    }
    // A type level DELETE is a conditional delete, which needs search criteria.
    const unconditional: JsonResponse = await app.request(`${base}/Patient`, { method: "DELETE" });
    expect(unconditional.status).toBe(400);
    expect((await unconditional.json()).issue[0].code).toBe("required");
  });

  it("leaves /_emulate paths to core routes", async () => {
    const app = createApp();
    app.get("/_emulate/ping", (c) => c.text("pong"));
    const res = await app.request(`${base}/_emulate/ping`);
    expect(await res.text()).toBe("pong");
  });
});
