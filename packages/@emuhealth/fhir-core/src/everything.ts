import { FhirError } from "./outcome.js";
import { isR4ResourceType } from "./resource-types.js";
import { parseReference } from "./search.js";
import type { FhirResource, FhirStore } from "./store.js";

export interface EverythingOptions {
  /** Only resources last updated at or after this instant. */
  since?: string;
  /** Only these resource types. */
  types?: string[];
}

const key = (r: FhirResource) => `${r.resourceType}/${r.id}`;

function referenceKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) referenceKeys(v, out);
  else if (value && typeof value === "object")
    for (const [name, child] of Object.entries(value)) {
      if (name === "reference" && typeof child === "string") {
        const target = parseReference(child);
        if (target) out.add(`${target[0]}/${target[1]}`);
      } else referenceKeys(child, out);
    }
  return out;
}

/** Validate a _type value: a comma separated list of R4 resource types. */
export function parseTypes(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const types = raw.split(",").filter(Boolean);
  for (const type of types)
    if (!isR4ResourceType(type)) throw new FhirError(400, "value", `Unknown resource type "${type}" in _type`);
  return types;
}

/**
 * Patient/$everything: the patients, every resource that references them, and the resources those point to
 * (practitioners, organizations, locations, medications). Other patients' records are never pulled in.
 * Order: each patient followed by its records, then the shared referenced resources.
 */
export function patientEverything(
  fhir: FhirStore,
  patientIds: string[],
  options: EverythingOptions = {},
): FhirResource[] {
  let since: number | undefined;
  if (options.since !== undefined) {
    since = Date.parse(options.since);
    if (Number.isNaN(since)) throw new FhirError(400, "value", `Invalid _since value "${options.since}"`);
  }
  const all = fhir.listAllCurrent();
  const byKey = new Map(all.map((r) => [key(r), r]));
  const patients = new Set(patientIds.map((id) => `Patient/${id}`));
  const refs = new Map(all.map((r) => [key(r), referenceKeys(r)]));

  const result: FhirResource[] = [];
  const seen = new Set<string>();
  const add = (r: FhirResource) => {
    if (!seen.has(key(r))) {
      seen.add(key(r));
      result.push(r);
    }
  };
  for (const patientKey of patients) {
    const patient = byKey.get(patientKey);
    if (!patient) continue;
    add(patient);
    for (const r of all) if (r.resourceType !== "Patient" && refs.get(key(r))!.has(patientKey)) add(r);
  }
  // One level of referenced resources: who and where, not other patients.
  for (const r of [...result])
    for (const target of refs.get(key(r))!) {
      const found = byKey.get(target);
      if (found && found.resourceType !== "Patient") add(found);
    }

  return result.filter(
    (r) =>
      (!options.types || options.types.includes(r.resourceType)) &&
      (since === undefined || Date.parse(String(r.meta?.lastUpdated)) >= since),
  );
}
