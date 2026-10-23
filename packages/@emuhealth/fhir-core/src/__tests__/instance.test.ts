import { describe, it, expect } from "vitest";
import { Hono } from "@emulators/core";
import { createFhirInstance } from "../index.js";

describe("createFhirInstance", () => {
  it("runs isolated FHIR servers that a host app forwards to", async () => {
    const host = new Hono();
    const one = createFhirInstance({ baseUrl: "http://localhost:9000", basePath: "/stores/one", generate: true });
    const two = createFhirInstance({ baseUrl: "http://localhost:9000", basePath: "/stores/two" });
    for (const method of ["GET", "POST"]) {
      host.on(method, "/stores/one/:rest{.*}", (c) => one.forward(c));
      host.on(method, "/stores/two/:rest{.*}", (c) => two.forward(c));
    }
    const read = await host.request("http://localhost:9000/stores/one/Patient/syn-patient-001");
    expect(read.status).toBe(200);
    expect((await host.request("http://localhost:9000/stores/two/Patient/syn-patient-001")).status).toBe(404);
    const created = await host.request("http://localhost:9000/stores/two/Patient", {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Patient", name: [{ family: "Example" }] }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Location")).toMatch(/^http:\/\/localhost:9000\/stores\/two\/Patient\//);
    const bundle = (await (await host.request("http://localhost:9000/stores/two/Patient")).json()) as { total: number };
    expect(bundle.total).toBe(1);
  });
});
