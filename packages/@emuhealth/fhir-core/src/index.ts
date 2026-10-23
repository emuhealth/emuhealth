import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { FHIR_JSON, registerFhirRoutes } from "./routes.js";
import { operationOutcome } from "./outcome.js";
import { getFhirStore, type FhirResource } from "./store.js";
import { generateSyntheticRecords, type GenerateOptions } from "./generator.js";
import { seedTerminology, terminologyFixtures } from "./terminology.js";
import { setSmartConfig, type SmartConfig } from "./smart.js";
import { recordsForVersion } from "./r5.js";
import { getFhirVersion, parseFhirVersion, setFhirVersion } from "./version.js";

export { registerFhirRoutes, FHIR_JSON, type FhirRouteOptions } from "./routes.js";
export { createFhirInstance, type FhirInstance, type FhirInstanceOptions } from "./instance.js";
export {
  FhirStore,
  getFhirStore,
  type FhirResource,
  type FhirResourceRecord,
  type FhirHistoryRecord,
  type FhirMethod,
  type WriteResult,
  type HistoryOptions,
} from "./store.js";
export { FhirError, operationOutcome, type OperationOutcome, type IssueCode } from "./outcome.js";
export { applyJsonPatch, type JsonPatchOperation } from "./json-patch.js";
export { processBundle, type BundleDeps } from "./bundle.js";
export { buildCapabilityStatement, type CapabilityOptions } from "./capability.js";
export { patientEverything, type EverythingOptions } from "./everything.js";
export { registerFhirInspector, resourceSummary } from "./inspector.js";
export { terminologyFixtures, seedTerminology, lookupCode, validateCode, TERMINOLOGY_TAG } from "./terminology.js";
export {
  startExport,
  exportManifest,
  getExportJob,
  deleteExportJob,
  NDJSON,
  type ExportJob,
  type ExportRequest,
} from "./bulk.js";
export {
  parseScopes,
  guardForToken,
  resolveAccess,
  inPatientCompartment,
  UNRESTRICTED,
  type AccessGuard,
  type Interaction,
  type ScopeGrant,
} from "./access.js";
export { guardedOperations, type GuardedOperations } from "./operations.js";
export {
  registerSmartRoutes,
  findAccessToken,
  issueSmartToken,
  getSmartConfig,
  setSmartConfig,
  type SmartClient,
  type SmartConfig,
  type SmartPaths,
  type SmartRouteOptions,
  type SmartTokenGrant,
  type SmartToken,
} from "./smart.js";
export {
  R4_RESOURCE_TYPES,
  R4B_RESOURCE_TYPES,
  R5_RESOURCE_TYPES,
  isR4ResourceType,
  isResourceType,
  resourceTypesFor,
  type FhirVersion,
} from "./resource-types.js";
export {
  DEFAULT_FHIR_VERSION,
  getFhirVersion,
  setFhirVersion,
  parseFhirVersion,
  mimeVersion,
  releaseName,
} from "./version.js";
export { toR5, recordsForVersion } from "./r5.js";
export { syntheticPeople, type SyntheticPerson } from "./people.js";
export {
  generateSyntheticRecords,
  DEFAULT_GENERATE_OPTIONS,
  SYNTHETIC_TAG,
  generatorTerminology,
  type GenerateOptions,
  type TerminologySubset,
} from "./generator.js";
export {
  parseSearch,
  runSearch,
  resolveIncludes,
  dateRange,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ParsedSearch,
  type SearchOptions,
  type SearchResult,
  type SearchContext,
  type IncludeDirective,
} from "./search.js";
export {
  SEARCH_PARAMS,
  COMMON_SEARCH_PARAMS,
  searchParamsFor,
  type SearchParamDefinition,
  type SearchParamType,
} from "./search-params.js";

export interface FhirSeedConfig {
  port?: number;
  baseUrl?: string;
  /**
   * Generated synthetic population. The fhir service starts with 5 generated patients;
   * an object replaces them with the given population and false starts without generated data.
   */
  generate?: GenerateOptions | false;
  /** Synthetic resources to load at startup. Resources with an id keep it; others get a server-assigned id. */
  resources?: FhirResource[];
  /** SMART App Launch clients and options. */
  smart?: SmartConfig;
  /** Terminology fixture CodeSystems (default true); false leaves them out. */
  terminology?: boolean;
  /** FHIR version to serve: 4.0.1 (R4, the default), 4.3.0 (R4B), or 5.0.0 (R5). */
  fhirVersion?: string;
}

/** Write generated records into the store, keeping their ids. */
export function seedSyntheticRecords(store: Store, options: GenerateOptions = {}): number {
  const fhir = getFhirStore(store);
  const records = recordsForVersion(generateSyntheticRecords(options), getFhirVersion(store));
  for (const resource of records) fhir.update(resource.resourceType, resource.id!, resource);
  return records.length;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: FhirSeedConfig): void {
  if (config.fhirVersion !== undefined) {
    const version = parseFhirVersion(config.fhirVersion);
    if (!version) throw new Error("fhir.fhirVersion must be 4.0.1 (R4), 4.3.0 (R4B), or 5.0.0 (R5)");
    if (version !== getFhirVersion(store)) {
      setFhirVersion(store, version);
      // The plugin seed generated the default population in the old version's shape.
      if (config.generate === undefined) {
        getFhirStore(store).clear();
        seedTerminology(store);
        seedSyntheticRecords(store);
      }
    }
  }
  const fhir = getFhirStore(store);
  if (config.smart !== undefined) setSmartConfig(store, config.smart);
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("fhir.generate must be an object of generator options or false");
    // Replace the default population from the plugin seed with the configured one.
    fhir.clear();
    seedTerminology(store);
    if (config.generate !== false) seedSyntheticRecords(store, config.generate);
  }
  if (config.terminology !== undefined && typeof config.terminology !== "boolean")
    throw new Error("fhir.terminology must be true or false");
  if (config.terminology === false) for (const cs of terminologyFixtures()) fhir.purge("CodeSystem", cs.id!);
  if (config.resources === undefined) return;
  if (!Array.isArray(config.resources)) throw new Error("fhir.resources must be an array of FHIR resources");
  for (const [index, resource] of config.resources.entries()) {
    try {
      if (typeof resource?.id === "string") fhir.update(resource.resourceType, resource.id, resource);
      else fhir.create(String(resource?.resourceType), resource);
    } catch (err) {
      throw new Error(`fhir.resources[${index}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const fhirPlugin: ServicePlugin = {
  name: "fhir",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    registerFhirRoutes(app, store, { baseUrl });
    // Anything else under this dedicated FHIR server is an OperationOutcome, not the core JSON 404.
    // /_emulate stays free for core routes (fonts, inspector) registered later.
    const notFound = (c: Context<AppEnv>) =>
      c.body(
        JSON.stringify(
          operationOutcome("not-supported", `${c.req.method} ${c.req.path} is not a supported FHIR interaction`),
        ),
        404,
        { "Content-Type": FHIR_JSON },
      );
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) app.on(method, "/:rest{(?!_emulate).*}", notFound);
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
  },
};

export default fhirPlugin;
