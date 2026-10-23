import { R4_RESOURCE_TYPES } from "./resource-types.js";
import { SEARCH_PARAMS, searchParamsFor } from "./search-params.js";
import type { FhirResource } from "./store.js";

export interface CapabilityOptions {
  /** Base URL including any base path, without a trailing slash. */
  base: string;
  /** Software name and version reported in the statement. */
  software?: { name: string; version?: string };
  /** Free text describing this server, for example the vendor being emulated. */
  description?: string;
}

const TYPE_INTERACTIONS = [
  "read",
  "vread",
  "update",
  "patch",
  "delete",
  "history-instance",
  "history-type",
  "create",
  "search-type",
];

/** The _include values a type supports: every reference parameter it defines. */
function searchIncludes(type: string): string[] {
  return [...searchParamsFor(type).values()].filter((d) => d.type === "reference").map((d) => `${type}:${d.name}`);
}

/** The _revinclude values that can point at a type: reference parameters on other types that target it or any type. */
function searchRevIncludes(type: string): string[] {
  const out: string[] = [];
  for (const [source, params] of Object.entries(SEARCH_PARAMS))
    for (const d of params)
      if (d.type === "reference" && (!d.targets || d.targets.includes(type))) out.push(`${source}:${d.name}`);
  return out;
}

/** A CapabilityStatement describing exactly what fhir-core implements. */
export function buildCapabilityStatement(options: CapabilityOptions): FhirResource {
  const software = options.software ?? { name: "emuhealth" };
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    publisher: "emuhealth",
    kind: "instance",
    software,
    implementation: {
      description:
        options.description ?? "emuhealth FHIR R4 emulator for development and testing. Synthetic data only.",
      url: options.base,
    },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json", "json"],
    patchFormat: ["application/json-patch+json"],
    rest: [
      {
        mode: "server",
        documentation: "Requests are not authenticated. Load synthetic data only, never real patient data.",
        resource: [...R4_RESOURCE_TYPES].map((type) => ({
          type,
          interaction: TYPE_INTERACTIONS.map((code) => ({ code })),
          versioning: "versioned-update",
          readHistory: true,
          updateCreate: true,
          conditionalCreate: false,
          conditionalRead: "not-supported",
          conditionalUpdate: false,
          conditionalDelete: "not-supported",
          searchInclude: searchIncludes(type),
          searchRevInclude: searchRevIncludes(type),
          searchParam: [...searchParamsFor(type).values()].map((d) => ({ name: d.name, type: d.type })),
          ...(type === "Patient"
            ? {
                operation: [
                  { name: "everything", definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything" },
                ],
              }
            : {}),
        })),
        interaction: [{ code: "transaction" }, { code: "batch" }, { code: "history-system" }],
      },
    ],
  };
}
