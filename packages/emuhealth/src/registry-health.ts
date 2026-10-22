import type { ServiceEntry } from "./registry.js";

// Health and life science services. Each emulator lives in packages/@emuhealth/<name>.
// Append new names to the end only: a service's position in this list sets its default port.
const HEALTH_SERVICE_NAME_LIST = ["fhir"] as const;
export type HealthServiceName = (typeof HEALTH_SERVICE_NAME_LIST)[number];
export const HEALTH_SERVICE_NAMES: readonly HealthServiceName[] = HEALTH_SERVICE_NAME_LIST;

export const HEALTH_SERVICE_REGISTRY: Record<HealthServiceName, ServiceEntry> = {
  fhir: {
    label: "FHIR R4 server emulator",
    endpoints:
      "create, read, vread, update (including create on update), JSON Patch, logical delete, _history, ETag and If-Match",
    async load() {
      const mod = await import("@emuhealth/fhir-core");
      return { plugin: mod.fhirPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "fhir-user", id: 1, scopes: [] };
    },
    initConfig: {
      fhir: {
        resources: [
          {
            resourceType: "Patient",
            id: "synthetic-patient-1",
            name: [{ family: "Example", given: ["Jamie"] }],
            gender: "female",
            birthDate: "1980-01-01",
          },
        ],
      },
    },
  },
};

// Health services listen on basePort + 100 + their position in HEALTH_SERVICE_NAMES
// (4100, 4101, ... with the default base port), so adding upstream services never moves them.
export const HEALTH_PORT_OFFSET = 100;

export function defaultServicePort(
  service: string,
  basePort: number,
  index: number,
  healthNames: readonly string[] = HEALTH_SERVICE_NAMES,
): number {
  const healthIndex = healthNames.indexOf(service);
  return healthIndex === -1 ? basePort + index : basePort + HEALTH_PORT_OFFSET + healthIndex;
}
