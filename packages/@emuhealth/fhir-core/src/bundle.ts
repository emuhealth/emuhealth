import { randomUUID } from "node:crypto";
import { conditionalCreate, conditionalDelete, conditionalUpdate, criteria } from "./conditional.js";
import { FhirError, operationOutcome } from "./outcome.js";
import type { GuardedOperations } from "./operations.js";
import type { FhirResource, WriteResult } from "./store.js";

/** What batch and transaction processing needs from the server. */
export interface BundleDeps {
  /** Store operations with the request's SMART access checks applied. */
  ops: GuardedOperations;
  /** Base URL including any base path, without a trailing slash. */
  base: string;
  search(type: string, params: Array<[string, string]>): FhirResource;
  history(params: Array<[string, string]>, type?: string, id?: string): FhirResource;
  /** Capture the store state; the returned function restores it. */
  snapshot(): () => void;
  /** Prefer header of the outer request. */
  prefer?: string;
}

interface BundleEntryRequest {
  method?: string;
  url?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  ifNoneExist?: string;
}

interface BundleEntry {
  fullUrl?: string;
  resource?: FhirResource;
  request?: BundleEntryRequest;
}

interface EntryResult {
  status: number;
  resource?: FhirResource;
  location?: string;
  etag?: string;
  lastModified?: string;
  outcome?: FhirResource;
}

const STATUS_TEXT: Record<number, string> = {
  200: "200 OK",
  201: "201 Created",
  204: "204 No Content",
  304: "304 Not Modified",
  400: "400 Bad Request",
  404: "404 Not Found",
  405: "405 Method Not Allowed",
  409: "409 Conflict",
  410: "410 Gone",
  412: "412 Precondition Failed",
  415: "415 Unsupported Media Type",
  422: "422 Unprocessable Entity",
  500: "500 Internal Server Error",
};

// Transactions apply deletes first, then creates, then updates and patches, then reads.
const TRANSACTION_ORDER: Record<string, number> = { DELETE: 0, POST: 1, PUT: 2, PATCH: 2, GET: 3, HEAD: 3 };

function parseUrl(url: string, base: string): { segments: string[]; params: Array<[string, string]> } {
  let path = url.startsWith(base) ? url.slice(base.length) : url;
  if (/^https?:\/\//.test(path)) throw new FhirError(400, "not-supported", `Entry url "${url}" is not on this server`);
  path = path.replace(/^\/+/, "");
  const q = path.indexOf("?");
  const params: Array<[string, string]> = q === -1 ? [] : [...new URLSearchParams(path.slice(q + 1))];
  const segments = (q === -1 ? path : path.slice(0, q)).split("/").filter(Boolean);
  return { segments, params };
}

function writeResult(type: string, result: WriteResult, base: string): EntryResult {
  return {
    status: result.created ? 201 : 200,
    resource: result.resource,
    location: `${base}/${type}/${result.resource.id}/_history/${result.versionId}`,
    etag: `W/"${result.versionId}"`,
    lastModified: result.lastUpdated,
  };
}

/** JSON Patch in a Bundle travels as a Binary resource (FHIR R4 3.1.0.7.1). */
function patchOperations(resource: FhirResource | undefined): unknown {
  if (resource?.resourceType !== "Binary" || resource.contentType !== "application/json-patch+json")
    throw new FhirError(
      400,
      "not-supported",
      "PATCH entries need a Binary resource with contentType application/json-patch+json",
    );
  try {
    return JSON.parse(Buffer.from(String(resource.data ?? ""), "base64").toString("utf8"));
  } catch {
    throw new FhirError(400, "structure", "PATCH entry Binary data is not base64 encoded JSON");
  }
}

function runEntry(entry: BundleEntry, deps: BundleDeps, assignedId?: string): EntryResult {
  const method = entry.request?.method?.toUpperCase();
  const url = entry.request?.url;
  if (!method || !url) throw new FhirError(400, "required", "Entry needs request.method and request.url");
  const { segments, params } = parseUrl(url, deps.base);
  const [type, id, historySegment, versionId] = segments;
  const fhir = deps.ops;

  if (method === "GET" || method === "HEAD") {
    if (type === "_history" && segments.length === 1) return { status: 200, resource: deps.history(params) };
    if (segments.length === 1) return { status: 200, resource: deps.search(type, params) };
    if (segments.length === 2 && id === "_history") return { status: 200, resource: deps.history(params, type) };
    if (segments.length === 3 && historySegment === "_history")
      return { status: 200, resource: deps.history(params, type, id) };
    if (segments.length === 4 && historySegment === "_history") {
      const version = fhir.vread(type, id, versionId);
      return { status: 200, resource: version.resource ?? undefined, etag: `W/"${version.version_id}"` };
    }
    if (segments.length === 2) {
      const record = fhir.read(type, id);
      const etag = `W/"${record.version_id}"`;
      if (entry.request?.ifNoneMatch?.replace(/^W\//, "") === `"${record.version_id}"`) return { status: 304, etag };
      return { status: 200, resource: record.resource, etag, lastModified: record.last_updated };
    }
  }
  if (method === "POST" && segments.length === 1) {
    if (!entry.request?.ifNoneExist) return writeResult(type, fhir.create(type, entry.resource, assignedId), deps.base);
    const outcome = conditionalCreate(fhir, deps.search, type, entry.resource, entry.request.ifNoneExist, assignedId);
    if ("created" in outcome) return writeResult(type, outcome.created, deps.base);
    const { existing } = outcome;
    return {
      status: 200,
      resource: existing.resource,
      location: `${deps.base}/${type}/${existing.id}/_history/${existing.versionId}`,
      etag: `W/"${existing.versionId}"`,
      lastModified: existing.lastUpdated,
    };
  }
  if (method === "PUT" && segments.length === 1)
    return writeResult(
      type,
      conditionalUpdate(fhir, deps.search, type, params, entry.resource, entry.request?.ifMatch, assignedId),
      deps.base,
    );
  if (method === "DELETE" && segments.length === 1) {
    const { versionId: deletedVersion } = conditionalDelete(fhir, deps.search, type, params);
    return { status: 204, ...(deletedVersion ? { etag: `W/"${deletedVersion}"` } : {}) };
  }
  if (params.length > 0) throw new FhirError(400, "not-supported", `Unsupported entry ${method} ${url}`);
  if (method === "PUT" && segments.length === 2)
    return writeResult(type, fhir.update(type, id, entry.resource, entry.request?.ifMatch), deps.base);
  if (method === "PATCH" && segments.length === 2)
    return writeResult(type, fhir.patch(type, id, patchOperations(entry.resource), entry.request?.ifMatch), deps.base);
  if (method === "DELETE" && segments.length === 2) {
    const { versionId: deletedVersion } = fhir.delete(type, id, entry.request?.ifMatch);
    return { status: 204, ...(deletedVersion ? { etag: `W/"${deletedVersion}"` } : {}) };
  }
  throw new FhirError(400, "not-supported", `Unsupported entry ${method} ${url}`);
}

function responseEntry(result: EntryResult, deps: BundleDeps): Record<string, unknown> {
  const minimal = /return=minimal/.test(deps.prefer ?? "");
  const resource = result.resource && !minimal ? result.resource : undefined;
  return {
    ...(resource?.id && resource.resourceType !== "Bundle"
      ? { fullUrl: `${deps.base}/${resource.resourceType}/${resource.id}` }
      : {}),
    ...(resource ? { resource } : {}),
    response: {
      status: STATUS_TEXT[result.status] ?? String(result.status),
      ...(result.location ? { location: result.location } : {}),
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.lastModified ? { lastModified: result.lastModified } : {}),
      ...(result.outcome ? { outcome: result.outcome } : {}),
    },
  };
}

function errorResult(err: unknown): EntryResult {
  if (err instanceof FhirError) return { status: err.status, outcome: err.toOutcome() as unknown as FhirResource };
  const message = err instanceof Error ? err.message : "Internal server error";
  return { status: 500, outcome: operationOutcome("exception", message, "fatal") as unknown as FhirResource };
}

/** Replace references to placeholder fullUrls (urn:uuid:..., urn:oid:...) with the resolved Type/id. */
function rewriteReferences(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteReferences(v, ids));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      key === "reference" && typeof child === "string" && ids.has(child)
        ? ids.get(child)
        : rewriteReferences(child, ids);
  }
  return out;
}

function conditionalReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) conditionalReferences(v, found);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      if (key === "reference" && typeof child === "string" && /^[A-Z][A-Za-z]+\?./.test(child)) found.add(child);
      else conditionalReferences(child, found);
  return found;
}

function responseBundle(type: string, entries: Array<Record<string, unknown>>): FhirResource {
  return {
    resourceType: "Bundle",
    id: randomUUID(),
    meta: { lastUpdated: new Date().toISOString() },
    type,
    entry: entries,
  };
}

function processBatch(entries: BundleEntry[], deps: BundleDeps): FhirResource {
  const responses = entries.map((entry) => {
    let result: EntryResult;
    try {
      result = runEntry(entry, deps);
    } catch (err) {
      result = errorResult(err);
    }
    return responseEntry(result, deps);
  });
  return responseBundle("batch-response", responses);
}

function processTransaction(entries: BundleEntry[], deps: BundleDeps): FhirResource {
  const ids = new Map<string, string>();
  const assigned = new Map<number, string>();
  const existing = new Map<number, EntryResult>();
  const written = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const method = entry.request?.method?.toUpperCase();
    if (!method || !entry.request?.url)
      throw new FhirError(400, "required", `entry[${index}] needs request.method and request.url`);
    const { segments, params } = parseUrl(entry.request.url, deps.base);
    const [type, id] = segments;
    if (method === "POST" && segments.length === 1) {
      if (entry.request.ifNoneExist) {
        const matches = deps.search(type, criteria(entry.request.ifNoneExist));
        const found = ((matches.entry ?? []) as Array<{ resource: FhirResource; search?: { mode?: string } }>).filter(
          (e) => e.search?.mode === "match",
        );
        if (found.length > 1)
          throw new FhirError(412, "conflict", `entry[${index}] ifNoneExist matched ${found.length} ${type} resources`);
        if (found.length === 1) {
          const match = found[0].resource;
          const record = deps.ops.read(type, match.id!);
          existing.set(index, {
            status: 200,
            resource: record.resource,
            location: `${deps.base}/${type}/${match.id}/_history/${record.version_id}`,
            etag: `W/"${record.version_id}"`,
            lastModified: record.last_updated,
          });
          if (entry.fullUrl) ids.set(entry.fullUrl, `${type}/${match.id}`);
          continue;
        }
      }
      const newId = randomUUID();
      assigned.set(index, newId);
      if (entry.fullUrl) ids.set(entry.fullUrl, `${type}/${newId}`);
    } else if (method === "PUT" && segments.length === 1) {
      // A conditional update resolves before any entry runs, so other entries can reference its fullUrl.
      const matches = deps.search(type, params) as FhirResource & {
        total?: number;
        entry?: Array<{ resource: FhirResource }>;
      };
      const bodyId = entry.resource?.id;
      const target = matches.total === 1 ? matches.entry![0].resource.id! : (bodyId ?? randomUUID());
      if ((matches.total ?? 0) === 0 && bodyId === undefined) assigned.set(index, target);
      if (entry.fullUrl) ids.set(entry.fullUrl, `${type}/${target}`);
    } else if (["PUT", "PATCH", "DELETE"].includes(method) && segments.length === 2 && params.length === 0) {
      if (written.has(`${type}/${id}`))
        throw new FhirError(400, "invalid", `entry[${index}] changes ${type}/${id}, which another entry also changes`);
      written.add(`${type}/${id}`);
      if (entry.fullUrl && !entry.fullUrl.startsWith(deps.base)) ids.set(entry.fullUrl, `${type}/${id}`);
    }
  }

  // Conditional references (FHIR R4 3.1.0.11.2), such as Practitioner?identifier=..., must match exactly one resource.
  for (const entry of entries)
    for (const reference of conditionalReferences(entry.resource)) {
      if (ids.has(reference)) continue;
      const [type, query] = [reference.slice(0, reference.indexOf("?")), reference.slice(reference.indexOf("?") + 1)];
      const found = deps.search(type, [...new URLSearchParams(query)]) as FhirResource & {
        total?: number;
        entry?: Array<{ resource: FhirResource; search?: { mode?: string } }>;
      };
      const matches = (found.entry ?? []).filter((e) => e.search?.mode === "match");
      if (found.total !== 1 || matches.length !== 1)
        throw new FhirError(
          412,
          "multiple-matches",
          `Conditional reference ${reference} matched ${found.total ?? 0} resources`,
        );
      ids.set(reference, `${type}/${matches[0].resource.id}`);
    }

  const prepared = entries.map((entry) =>
    entry.resource ? { ...entry, resource: rewriteReferences(entry.resource, ids) as FhirResource } : entry,
  );
  const order = prepared
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (TRANSACTION_ORDER[a.entry.request!.method!.toUpperCase()] ?? 4) -
          (TRANSACTION_ORDER[b.entry.request!.method!.toUpperCase()] ?? 4) || a.index - b.index,
    );

  const restore = deps.snapshot();
  const results: EntryResult[] = [];
  try {
    for (const { entry, index } of order) {
      try {
        results[index] = existing.get(index) ?? runEntry(entry, deps, assigned.get(index));
      } catch (err) {
        if (err instanceof FhirError) throw new FhirError(err.status, err.code, `entry[${index}]: ${err.message}`);
        throw err;
      }
    }
  } catch (err) {
    restore();
    throw err;
  }
  return responseBundle(
    "transaction-response",
    results.map((r) => responseEntry(r, deps)),
  );
}

/** Process a batch or transaction Bundle and return the response Bundle. */
export function processBundle(body: unknown, deps: BundleDeps): FhirResource {
  if (!body || typeof body !== "object" || (body as FhirResource).resourceType !== "Bundle")
    throw new FhirError(400, "invalid", "Request body must be a Bundle");
  const bundle = body as FhirResource & { type?: string; entry?: BundleEntry[] };
  if (bundle.entry !== undefined && !Array.isArray(bundle.entry))
    throw new FhirError(400, "structure", "Bundle.entry must be an array");
  const entries = bundle.entry ?? [];
  if (bundle.type === "batch") return processBatch(entries, deps);
  if (bundle.type === "transaction") return processTransaction(entries, deps);
  throw new FhirError(
    400,
    "not-supported",
    `Bundle type "${bundle.type}" cannot be processed; use batch or transaction`,
  );
}
