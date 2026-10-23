import type { Store } from "@emulators/core";
import type { FhirVersion } from "./resource-types.js";

export type { FhirVersion } from "./resource-types.js";

export const DEFAULT_FHIR_VERSION: FhirVersion = "4.0.1";

const ALIASES: Record<string, FhirVersion> = {
  R4: "4.0.1",
  "4.0": "4.0.1",
  "4.0.1": "4.0.1",
  R4B: "4.3.0",
  "4.3": "4.3.0",
  "4.3.0": "4.3.0",
  R5: "5.0.0",
  "5.0": "5.0.0",
  "5.0.0": "5.0.0",
};

/** Read a FHIR version from config: 4.0.1, 4.3.0, 5.0.0, their major.minor forms, or R4, R4B, R5. */
export function parseFhirVersion(input: unknown): FhirVersion | undefined {
  return typeof input === "string" ? (ALIASES[input.trim().toUpperCase()] ?? ALIASES[input.trim()]) : undefined;
}

/** The major.minor form used by the fhirVersion MIME type parameter and $versions. */
export const mimeVersion = (version: FhirVersion) => version.split(".").slice(0, 2).join(".");

export const releaseName = (version: FhirVersion) => (version === "5.0.0" ? "R5" : version === "4.3.0" ? "R4B" : "R4");

// Kept outside the store data so the version survives store.reset().
const versions = new WeakMap<Store, FhirVersion>();

export function getFhirVersion(store: Store): FhirVersion {
  return versions.get(store) ?? DEFAULT_FHIR_VERSION;
}

export function setFhirVersion(store: Store, version: FhirVersion): void {
  versions.set(store, version);
}
