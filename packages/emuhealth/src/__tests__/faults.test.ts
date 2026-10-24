import { describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";
import { validateFaults } from "../faults.js";

describe("fault injection", () => {
  it("applies seed config faults and runtime changes through /_emulate/faults", async () => {
    const fhir = await createEmulator({
      service: "fhir",
      port: 0,
      seed: { fhir: { faults: { outage: { status: 503, retryAfterSeconds: 7 }, paths: ["/Patient"] } } },
    });
    try {
      const down = await fetch(`${fhir.url}/Patient`, { headers: { Accept: "application/fhir+json" } });
      expect(down.status).toBe(503);
      expect(down.headers.get("Retry-After")).toBe("7");
      expect(((await down.json()) as any).resourceType).toBe("OperationOutcome");
      // Paths outside the list, and the inspector and control routes, are untouched.
      expect((await fetch(`${fhir.url}/Observation?_count=1`)).status).toBe(200);
      expect((await fetch(`${fhir.url}/metadata`)).status).toBe(200);

      const put = (body: unknown) =>
        fetch(`${fhir.url}/_emulate/faults`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await put({ rateLimit: { requests: 2, windowSeconds: 60 } })).status).toBe(200);
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${fhir.url}/Patient`)).status);
      expect(statuses).toEqual([200, 200, 429]);
      const limited = await fetch(`${fhir.url}/Patient`);
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(((await limited.json()) as any).error).toBe("rate_limited");

      await put({ expiredTokens: {} });
      expect((await fetch(`${fhir.url}/Patient`)).status).toBe(200);
      const expired = await fetch(`${fhir.url}/Patient`, { headers: { Authorization: "Bearer anything" } });
      expect(expired.status).toBe(401);
      expect(expired.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');

      await put({ latency: { ms: 250 } });
      const started = Date.now();
      expect((await fetch(`${fhir.url}/Patient`)).status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(240);

      expect((await put({ nope: true })).status).toBe(400);
      expect((await fetch(`${fhir.url}/_emulate/faults`, { method: "DELETE" })).status).toBe(204);
      expect(await (await fetch(`${fhir.url}/_emulate/faults`)).json()).toEqual({});
    } finally {
      await fhir.close();
    }
  });

  it("validates fault config", () => {
    expect(() => validateFaults({ outage: { status: 200 } })).toThrow("faults.outage.status must be 400 to 599");
    expect(() => validateFaults({ rateLimit: { requests: 1, windowSeconds: 0 } })).toThrow("windowSeconds");
    expect(() => validateFaults({ expiredTokens: { probability: 2 } })).toThrow("from 0 to 1");
    expect(validateFaults(undefined)).toBeUndefined();
  });
});
