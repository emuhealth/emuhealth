import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Store } from "@emulators/core";
import { UNRESTRICTED } from "./access.js";
import { processBundle } from "./bundle.js";
import { guardedOperations } from "./operations.js";
import { FhirError } from "./outcome.js";
import { parseSearch, runSearch } from "./search.js";
import { getFhirStore, type FhirResource } from "./store.js";

// Loads FHIR data files into a store: Synthea output (transaction Bundles, with hospital and practitioner Bundles
// that the patient Bundles reference conditionally), other Bundles, single resources, and Bulk Data NDJSON.

/** Synthea writes these alongside the patient Bundles; patients reference them, so they load first. */
const FIRST = /^(hospitalInformation|practitionerInformation)/;

function listFiles(path: string): string[] {
  const full = resolve(path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .filter((name) => [".json", ".ndjson"].includes(extname(name)))
    .sort((a, b) => Number(FIRST.test(b)) - Number(FIRST.test(a)) || a.localeCompare(b))
    .map((name) => join(full, name));
}

/** Import files and directories; returns how many resources were written. */
export function importFhirFiles(store: Store, paths: string[], base: string): number {
  const fhir = getFhirStore(store);
  const ops = guardedOperations(fhir, UNRESTRICTED);
  const search = (type: string, params: Array<[string, string]>): FhirResource => {
    const parsed = parseSearch(type, params);
    const ctx = {
      resolve: (t: string, id: string) => fhir.find(t, id) ?? undefined,
      listCurrent: (t: string) => fhir.listCurrent(t),
    };
    const matches = runSearch(fhir.listCurrent(type), parsed, ctx).matches;
    return {
      resourceType: "Bundle",
      type: "searchset",
      total: matches.length,
      entry: matches.map((resource) => ({ resource, search: { mode: "match" } })),
    };
  };
  const upsert = (resource: FhirResource) =>
    typeof resource.id === "string"
      ? ops.update(resource.resourceType, resource.id, resource)
      : ops.create(resource.resourceType, resource);

  let written = 0;
  for (const file of paths.flatMap(listFiles)) {
    try {
      const text = readFileSync(file, "utf8");
      const items: FhirResource[] =
        extname(file) === ".ndjson"
          ? text
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
          : [JSON.parse(text)];
      for (const item of items) {
        if (item?.resourceType === "Bundle" && (item.type === "transaction" || item.type === "batch")) {
          const result = processBundle(item, {
            ops,
            base,
            search,
            history: () => {
              throw new FhirError(400, "not-supported", "History reads are not supported in imported Bundles");
            },
            snapshot: () => {
              const saved = store.snapshot();
              return () => store.restore(saved);
            },
          }) as FhirResource & { entry?: Array<{ response?: { status?: string } }> };
          written += (result.entry ?? []).filter((e) => /^20[01]/.test(e.response?.status ?? "")).length;
        } else if (item?.resourceType === "Bundle")
          for (const entry of (item.entry ?? []) as Array<{ resource?: FhirResource }>) {
            if (entry.resource) {
              upsert(entry.resource);
              written++;
            }
          }
        else {
          upsert(item);
          written++;
        }
      }
    } catch (error) {
      throw new Error(`fhir.import ${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
  return written;
}
