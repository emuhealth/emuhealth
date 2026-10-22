import { describe, expect, it } from "vitest";
import { HEALTH_SERVICE_NAMES, HEALTH_SERVICE_REGISTRY, defaultServicePort } from "../registry-health.js";
import { SERVICE_NAMES, SERVICE_REGISTRY } from "../registry.js";

describe("health service registry", () => {
  it("is merged into the main registry after the upstream services", () => {
    expect(SERVICE_NAMES.slice(SERVICE_NAMES.length - HEALTH_SERVICE_NAMES.length)).toEqual(HEALTH_SERVICE_NAMES);
    for (const name of HEALTH_SERVICE_NAMES) {
      expect(SERVICE_REGISTRY[name]).toBe(HEALTH_SERVICE_REGISTRY[name]);
    }
    expect(Object.keys(HEALTH_SERVICE_REGISTRY).sort()).toEqual([...HEALTH_SERVICE_NAMES].sort());
  });

  it("does not reuse upstream service names", () => {
    const upstream = SERVICE_NAMES.slice(0, SERVICE_NAMES.length - HEALTH_SERVICE_NAMES.length);
    expect(HEALTH_SERVICE_NAMES.filter((name) => upstream.includes(name))).toEqual([]);
  });
});

describe("defaultServicePort", () => {
  const healthNames = ["fhir", "epic"];

  it("keeps upstream services on base port plus selection index", () => {
    expect(defaultServicePort("vercel", 4000, 0, healthNames)).toBe(4000);
    expect(defaultServicePort("github", 4000, 1, healthNames)).toBe(4001);
  });

  it("gives health services a fixed port from 4100 regardless of selection", () => {
    expect(defaultServicePort("fhir", 4000, 0, healthNames)).toBe(4100);
    expect(defaultServicePort("fhir", 4000, 14, healthNames)).toBe(4100);
    expect(defaultServicePort("epic", 4000, 3, healthNames)).toBe(4101);
  });

  it("moves the health range with a custom base port", () => {
    expect(defaultServicePort("epic", 5000, 0, healthNames)).toBe(5101);
  });
});
