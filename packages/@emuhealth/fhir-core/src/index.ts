import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { registerFhirRoutes } from "./routes.js";
import { getFhirStore, type FhirResource } from "./store.js";

export { registerFhirRoutes, FHIR_JSON, type FhirRouteOptions } from "./routes.js";
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
export { R4_RESOURCE_TYPES, isR4ResourceType } from "./resource-types.js";
export {
  parseSearch,
  runSearch,
  dateRange,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ParsedSearch,
  type SearchOptions,
  type SearchResult,
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
  /** Synthetic resources to load at startup. Resources with an id keep it; others get a server-assigned id. */
  resources?: FhirResource[];
}

export function seedFromConfig(store: Store, _baseUrl: string, config: FhirSeedConfig): void {
  if (config.resources === undefined) return;
  if (!Array.isArray(config.resources)) throw new Error("fhir.resources must be an array of FHIR resources");
  const fhir = getFhirStore(store);
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
  },
};

export default fhirPlugin;
