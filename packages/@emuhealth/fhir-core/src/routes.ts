import { randomUUID } from "node:crypto";
import type { Context, Hono, Store } from "@emulators/core";
import { FhirError, operationOutcome } from "./outcome.js";
import { processBundle } from "./bundle.js";
import { buildCapabilityStatement } from "./capability.js";
import { registerSmartRoutes, type SmartPaths, type SmartRouteOptions } from "./smart.js";
import { registerFhirInspector } from "./inspector.js";
import { lookupCode, validateCode } from "./terminology.js";
import { resolveAccess, UNRESTRICTED, type AccessGuard } from "./access.js";
import { guardedOperations } from "./operations.js";
import { conditionalCreate, conditionalDelete, conditionalUpdate } from "./conditional.js";
import { NDJSON, deleteExportJob, exportManifest, getExportJob, startExport, type ExportJob } from "./bulk.js";
import { parseTypes, patientEverything } from "./everything.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseSearch,
  resolveIncludes,
  runSearch,
  type SearchContext,
} from "./search.js";
import { getFhirStore, type FhirHistoryRecord, type FhirResource, type WriteResult } from "./store.js";
import { getFhirVersion, mimeVersion, setFhirVersion, DEFAULT_FHIR_VERSION, type FhirVersion } from "./version.js";

export const FHIR_JSON = "application/fhir+json; charset=utf-8";

export interface FhirRouteOptions {
  /** Public base URL of the server, without a trailing slash (for example http://localhost:4100). */
  baseUrl: string;
  /** Path the FHIR API is mounted under, for example "/api/FHIR/R4". Defaults to the server root. */
  basePath?: string;
  /** Software reported in the CapabilityStatement at /metadata. */
  software?: { name: string; version?: string };
  /** Implementation description reported in the CapabilityStatement, for example the vendor being emulated. */
  description?: string;
  /** SMART App Launch endpoint paths for vendors that use their own (absolute paths on this server), and vendor fields for token responses. */
  smart?: {
    paths?: Partial<SmartPaths>;
    tokenExtras?: SmartRouteOptions["tokenExtras"];
    clientCredentialsWithSecret?: boolean;
    patientAccess?: boolean;
  };
  /** Adjust every search result Bundle, for vendor quirks such as an OperationOutcome entry on empty results. */
  searchBundle?: (bundle: FhirResource, type: string) => FhirResource;
  /** Path of the HTML inspector (default /_inspector), or false to leave it out. */
  inspectorPath?: string | false;
  /** FHIR version to serve (decision 0016). Without it the store's version applies, 4.0.1 by default. */
  fhirVersion?: FhirVersion;
}

const TYPE = ":type{[A-Z][A-Za-z]+}";
// The core router ends a param pattern at the first "}", so the 64 character limit is checked by the store.
const ID = ":id{[A-Za-z0-9\\-.]+}";
const STATUS_TEXT: Record<FhirHistoryRecord["method"], string> = {
  POST: "201 Created",
  PUT: "200 OK",
  PATCH: "200 OK",
  DELETE: "204 No Content",
};

// Context is generic over the app env; the routes only use env-independent members.
type AnyContext = Context<any, any>;

/** The JSON media type, with a fhirVersion parameter when the server is not on the default R4 (decision 0016). */
function fhirJsonType(c: AnyContext): string {
  const version = c.get("fhirVersion") as FhirVersion | undefined;
  return version && version !== DEFAULT_FHIR_VERSION
    ? `application/fhir+json; fhirVersion=${mimeVersion(version)}; charset=utf-8`
    : FHIR_JSON;
}

function fhirJson(c: AnyContext, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return c.body(JSON.stringify(body), status, { "Content-Type": fhirJsonType(c), ...headers });
}

/** The fhirVersion parameter values in a media type header (Accept may list several types). */
function requestedVersions(header: string | undefined): string[] {
  return [...(header ?? "").matchAll(/fhirVersion\s*=\s*"?([0-9.]+)"?/gi)].map((m) => m[1]);
}

function versionHeaders(versionId: number, lastUpdated: string): Record<string, string> {
  return { ETag: `W/"${versionId}"`, "Last-Modified": new Date(lastUpdated).toUTCString() };
}

async function readJson(c: AnyContext, accepted: string[]): Promise<unknown> {
  const contentType = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!accepted.includes(contentType))
    throw new FhirError(
      415,
      "not-supported",
      `Unsupported Content-Type "${contentType || "none"}". Use ${accepted[0]}`,
    );
  try {
    return JSON.parse(await c.req.text());
  } catch {
    throw new FhirError(400, "structure", "Request body is not valid JSON");
  }
}

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new FhirError(400, "value", `Invalid _count value "${value}"`);
  return Number(value);
}

function handle(handler: (c: AnyContext) => Promise<Response> | Response) {
  return async (c: AnyContext): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof FhirError) return fhirJson(c, err.toOutcome(), err.status, err.headers);
      const message = err instanceof Error ? err.message : "Internal server error";
      return fhirJson(c, operationOutcome("exception", message, "fatal"), 500);
    }
  };
}

/** Mount the FHIR R4 REST API (create, read, vread, update, patch, delete, history, search, batch, transaction). */
export function registerFhirRoutes(app: Hono<any>, store: Store, options: FhirRouteOptions): void {
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const base = `${options.baseUrl.replace(/\/+$/, "")}${basePath}`;
  if (options.fhirVersion) setFhirVersion(store, options.fhirVersion);

  // fhirVersion negotiation (decision 0016): one version per server; asking for another one is an error.
  app.use(`${basePath}/:fhirPath{.*}`, async (c: AnyContext, next: () => Promise<void>) => {
    const version = getFhirVersion(store);
    c.set("fhirVersion", version);
    const wanted = mimeVersion(version);
    const accepted = requestedVersions(c.req.header("Accept"));
    if (accepted.length && !accepted.includes(wanted))
      return fhirJson(
        c,
        operationOutcome(
          "not-supported",
          `This server serves FHIR ${wanted}; it cannot return fhirVersion ${accepted.join(", ")}`,
        ),
        406,
      );
    const sent = requestedVersions(c.req.header("Content-Type"));
    if (sent.length && sent[0] !== wanted)
      return fhirJson(
        c,
        operationOutcome(
          "not-supported",
          `This server accepts FHIR ${wanted}; the request body is fhirVersion ${sent[0]}`,
        ),
        415,
      );
    await next();
  });
  const fhir = () => getFhirStore(store);
  const searchContext = (): SearchContext => {
    const current = fhir();
    return { resolve: (t, id) => current.find(t, id), listCurrent: (t) => current.listCurrent(t) };
  };
  /** SMART access for this request (decision 0010): unrestricted without a token unless fhir.smart.required. */
  const access = (c: AnyContext): AccessGuard => resolveAccess(store, c.req.header("Authorization"), searchContext());
  const ops = (c: AnyContext) => guardedOperations(fhir(), access(c));

  function writeResponse(c: AnyContext, result: WriteResult, type: string): Response {
    const status = result.created ? 201 : 200;
    const headers = versionHeaders(result.versionId, result.lastUpdated);
    if (result.created) headers.Location = `${base}/${type}/${result.resource.id}/_history/${result.versionId}`;
    const prefer = c.req.header("Prefer") ?? "";
    if (/return=minimal/.test(prefer)) return c.body(null, status, headers);
    if (/return=OperationOutcome/.test(prefer))
      return fhirJson(
        c,
        operationOutcome("processing", `${type}/${result.resource.id} saved`, "information"),
        status,
        headers,
      );
    return fhirJson(c, result.resource, status, headers);
  }

  function historyBundle(
    params: Array<[string, string]>,
    type?: string,
    id?: string,
    guard: AccessGuard = UNRESTRICTED,
  ): FhirResource {
    const instance = Boolean(type && id);
    guard.require(type ?? "*", instance ? "r" : "s");
    const query = new URLSearchParams(params);
    const since = query.get("_since") ?? undefined;
    const count = parseCount(query.get("_count") ?? undefined);
    const all = fhir().listHistory({ type, id, since }).entries;
    if (type && id && all.length === 0 && since === undefined)
      throw new FhirError(404, "not-found", `${type}/${id} is not known`);
    let visible = all;
    if (guard !== UNRESTRICTED) {
      // Deleted versions have no resource; they stay visible only in the history of a resource the token can see.
      const canSeeInstance = instance && all.some((h) => h.resource && guard.allows(h.resource, "r"));
      if (instance && !canSeeInstance && all.length > 0)
        throw new FhirError(404, "not-found", `${type}/${id} is not known`);
      visible = all.filter((h) => (h.resource ? guard.allows(h.resource, instance ? "r" : "s") : canSeeInstance));
    }
    const total = visible.length;
    const entries = count === undefined ? visible : visible.slice(0, count);
    const path = [type, id, "_history"].filter(Boolean).join("/");
    const qs = query.toString();
    return {
      resourceType: "Bundle",
      id: randomUUID(),
      meta: { lastUpdated: new Date().toISOString() },
      type: "history",
      total,
      link: [{ relation: "self", url: `${base}/${path}${qs ? `?${qs}` : ""}` }],
      entry: entries.map((h: FhirHistoryRecord) => ({
        fullUrl: `${base}/${h.resource_type}/${h.fhir_id}`,
        ...(h.resource ? { resource: h.resource } : {}),
        request: { method: h.method, url: h.method === "POST" ? h.resource_type : `${h.resource_type}/${h.fhir_id}` },
        response: {
          status: STATUS_TEXT[h.method],
          etag: `W/"${h.version_id}"`,
          lastModified: h.last_updated,
        },
      })),
    };
  }

  function history(c: AnyContext, type?: string, id?: string): Response {
    return fhirJson(c, historyBundle([...new URL(c.req.url).searchParams], type, id, access(c)));
  }

  async function search(c: AnyContext, type: string): Promise<Response> {
    const params: Array<[string, string]> = [...new URL(c.req.url).searchParams];
    if (c.req.method === "POST") {
      const contentType = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
      if (contentType && contentType !== "application/x-www-form-urlencoded")
        throw new FhirError(415, "not-supported", "POST _search needs application/x-www-form-urlencoded parameters");
      params.push(...new URLSearchParams(await c.req.text()));
    }
    const strict = /handling=strict/.test(c.req.header("Prefer") ?? "");
    return fhirJson(c, searchBundle(type, params, strict, access(c)));
  }

  function searchBundle(
    type: string,
    params: Array<[string, string]>,
    strict = false,
    guard: AccessGuard = UNRESTRICTED,
  ): FhirResource {
    guard.require(type, "s");
    const parsed = parseSearch(type, params, { strict });
    const ctx = searchContext();
    const matches = runSearch(fhir().listCurrent(type), parsed, ctx).matches.filter((r) => guard.allows(r, "s"));
    const total = matches.length;
    const link = (offset: number) => {
      const query = new URLSearchParams(parsed.applied);
      if (offset > 0) query.set("_getpagesoffset", String(offset));
      const qs = query.toString();
      return `${base}/${type}${qs ? `?${qs}` : ""}`;
    };
    const links = [{ relation: "self", url: link(parsed.offset) }];
    if (!parsed.summaryCount && parsed.count > 0) {
      if (parsed.offset + parsed.count < total)
        links.push({ relation: "next", url: link(parsed.offset + parsed.count) });
      if (parsed.offset > 0) links.push({ relation: "previous", url: link(Math.max(0, parsed.offset - parsed.count)) });
    }
    const page = parsed.summaryCount ? [] : matches.slice(parsed.offset, parsed.offset + parsed.count);
    const included = resolveIncludes(page, parsed, ctx).filter((r) => guard.allows(r, "r"));
    const result: FhirResource = {
      resourceType: "Bundle",
      id: randomUUID(),
      meta: { lastUpdated: new Date().toISOString() },
      type: "searchset",
      total,
      link: links,
      entry: [
        ...page.map((resource) => ({
          fullUrl: `${base}/${type}/${resource.id}`,
          resource,
          search: { mode: "match" },
        })),
        ...included.map((resource) => ({
          fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
          resource,
          search: { mode: "include" },
        })),
      ],
    };
    return options.searchBundle ? options.searchBundle(result, type) : result;
  }

  /** Search used to match conditional criteria, with the request's access applied. */
  const conditionalSearch =
    (guard: AccessGuard) =>
    (type: string, params: Array<[string, string]>): FhirResource =>
      searchBundle(type, params, false, guard);

  async function bundle(c: AnyContext): Promise<Response> {
    const body = await readJson(c, ["application/fhir+json", "application/json"]);
    const prefer = c.req.header("Prefer");
    const guard = access(c);
    return fhirJson(
      c,
      processBundle(body, {
        ops: guardedOperations(fhir(), guard),
        base,
        prefer,
        search: (type, params) => searchBundle(type, params, false, guard),
        history: (params, type, id) => historyBundle(params, type, id, guard),
        snapshot: () => {
          const saved = store.snapshot();
          return () => store.restore(saved);
        },
      }),
    );
  }

  const smartPaths = registerSmartRoutes(app, store, {
    base,
    basePath,
    paths: options.smart?.paths,
    tokenExtras: options.smart?.tokenExtras,
    clientCredentialsWithSecret: options.smart?.clientCredentialsWithSecret,
    patientAccess: options.smart?.patientAccess,
  });
  if (options.inspectorPath !== false)
    registerFhirInspector(app, store, { path: options.inspectorPath ?? "/_inspector", base });
  const origin = new URL(base).origin;

  app.get(
    `${basePath}/metadata`,
    handle((c) =>
      fhirJson(
        c,
        buildCapabilityStatement({
          base,
          software: options.software,
          description: options.description,
          fhirVersion: getFhirVersion(store),
          oauth: {
            authorize: `${origin}${smartPaths.authorize}`,
            token: `${origin}${smartPaths.token}`,
            introspect: `${origin}${smartPaths.introspect}`,
            revoke: `${origin}${smartPaths.revoke}`,
          },
        }),
      ),
    ),
  );

  // $versions: the one version this server serves.
  app.get(
    `${basePath}/$versions`,
    handle((c) => {
      const version = mimeVersion(getFhirVersion(store));
      if (/application\/json/.test(c.req.header("Accept") ?? "") && !/fhir\+json/.test(c.req.header("Accept") ?? ""))
        return c.json({ versions: [version], default: version });
      return fhirJson(c, {
        resourceType: "Parameters",
        parameter: [
          { name: "version", valueCode: version },
          { name: "default", valueCode: version },
        ],
      });
    }),
  );

  function everything(c: AnyContext, id?: string): Response {
    const store = fhir();
    const guard = access(c);
    guard.require("Patient", "r");
    // Instance level: 404 or 410 when the patient is unknown, deleted, or outside the token's patient.
    const ids = id
      ? [guardedOperations(store, guard).read("Patient", id).resource.id!]
      : store
          .listCurrent("Patient")
          .filter((p) => guard.allows(p, "r"))
          .map((p) => p.id!);
    const query = new URL(c.req.url).searchParams;
    const count = Math.min(parseCount(query.get("_count") ?? undefined) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = parseCount(query.get("_getpagesoffset") ?? undefined) ?? 0;
    const records = patientEverything(store, ids, {
      since: query.get("_since") ?? undefined,
      types: parseTypes(query.get("_type") ?? undefined, fhir().version),
    }).filter((r) => guard.allows(r, "r"));
    const path = `${base}/Patient${id ? `/${id}` : ""}/$everything`;
    const link = (pageOffset: number) => {
      const params = new URLSearchParams([...query].filter(([k]) => ["_since", "_type", "_count"].includes(k)));
      if (pageOffset > 0) params.set("_getpagesoffset", String(pageOffset));
      const qs = params.toString();
      return `${path}${qs ? `?${qs}` : ""}`;
    };
    const links = [{ relation: "self", url: link(offset) }];
    if (count > 0 && offset + count < records.length) links.push({ relation: "next", url: link(offset + count) });
    if (offset > 0) links.push({ relation: "previous", url: link(Math.max(0, offset - count)) });
    return fhirJson(c, {
      resourceType: "Bundle",
      id: randomUUID(),
      meta: { lastUpdated: new Date().toISOString() },
      type: "searchset",
      total: records.length,
      link: links,
      entry: records.slice(offset, offset + count).map((resource) => ({
        fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
        resource,
        search: { mode: "match" },
      })),
    });
  }

  app.get(
    `${basePath}/Patient/$everything`,
    handle((c) => everything(c)),
  );
  app.get(
    `${basePath}/Patient/${ID}/$everything`,
    handle((c) => everything(c, c.req.param("id"))),
  );

  // Bulk Data $export: kick-off returns 202 with a status URL; the emulator finishes jobs immediately.
  function kickOff(c: AnyContext, level: "system" | "patient" | "group", groupId?: string): Response {
    if (!/respond-async/.test(c.req.header("Prefer") ?? ""))
      throw new FhirError(400, "required", "Bulk export needs the Prefer: respond-async header");
    const job = startExport(store, fhir(), access(c), {
      level,
      groupId,
      params: new URL(c.req.url).searchParams,
      request: c.req.url,
    });
    return c.body(null, 202, { "Content-Location": `${base}/$export-status/${job.id}` });
  }

  /** Jobs started with a token can only be read with a token from the same client. */
  function exportJob(c: AnyContext): ExportJob {
    const job = getExportJob(store, c.req.param("job"));
    if (!job) throw new FhirError(404, "not-found", "Unknown or deleted export job");
    if (job.requiresAccessToken) {
      const guard = access(c);
      if (!guard.token)
        throw new FhirError(401, "login", "This export needs an access token", {
          "WWW-Authenticate": 'Bearer realm="fhir"',
        });
      if (guard.token.clientId !== job.clientId)
        throw new FhirError(403, "forbidden", "This export belongs to another client");
    }
    return job;
  }

  app.get(
    `${basePath}/$export`,
    handle((c) => kickOff(c, "system")),
  );
  app.get(
    `${basePath}/Patient/$export`,
    handle((c) => kickOff(c, "patient")),
  );
  app.get(
    `${basePath}/Group/${ID}/$export`,
    handle((c) => kickOff(c, "group", c.req.param("id"))),
  );
  app.get(
    `${basePath}/$export-status/:job`,
    handle((c) => {
      const job = exportJob(c);
      return c.json(
        exportManifest(job, (type) => `${base}/$export-file/${job.id}/${type}.ndjson`),
        200,
      );
    }),
  );
  app.delete(
    `${basePath}/$export-status/:job`,
    handle((c) => {
      const job = exportJob(c);
      deleteExportJob(store, job.id);
      return c.body(null, 202);
    }),
  );
  app.get(
    `${basePath}/$export-file/:job/:file{[A-Za-z]+\\.ndjson}`,
    handle((c) => {
      const job = exportJob(c);
      const type = c.req.param("file").replace(/\.ndjson$/, "");
      const text = job.files[type];
      if (text === undefined) throw new FhirError(404, "not-found", `No ${type} file in this export`);
      return c.body(text, 200, { "Content-Type": NDJSON });
    }),
  );

  // Terminology operations on the CodeSystems in the store (fixtures and any you add).
  app.get(
    `${basePath}/CodeSystem/$lookup`,
    handle((c) => {
      access(c).require("CodeSystem", "r");
      return fhirJson(c, lookupCode(fhir(), c.req.query("system"), c.req.query("code")));
    }),
  );
  app.get(
    `${basePath}/CodeSystem/$validate-code`,
    handle((c) => {
      access(c).require("CodeSystem", "r");
      return fhirJson(
        c,
        validateCode(fhir(), c.req.query("url") ?? c.req.query("system"), c.req.query("code"), c.req.query("display")),
      );
    }),
  );

  // POST to the base URL processes batch and transaction Bundles.
  app.post(`${basePath}/`, handle(bundle));
  if (basePath) app.post(basePath, handle(bundle));

  app.get(
    `${basePath}/${TYPE}`,
    handle((c) => search(c, c.req.param("type"))),
  );
  app.post(
    `${basePath}/${TYPE}/_search`,
    handle((c) => search(c, c.req.param("type"))),
  );

  // History routes come first so "_history" is never taken for a resource type or id.
  app.get(
    `${basePath}/_history`,
    handle((c) => history(c)),
  );
  app.get(
    `${basePath}/${TYPE}/_history`,
    handle((c) => history(c, c.req.param("type"))),
  );
  app.get(
    `${basePath}/${TYPE}/${ID}/_history`,
    handle((c) => history(c, c.req.param("type"), c.req.param("id"))),
  );

  app.get(
    `${basePath}/${TYPE}/${ID}/_history/:vid`,
    handle((c) => {
      const version = ops(c).vread(c.req.param("type"), c.req.param("id"), c.req.param("vid"));
      return fhirJson(c, version.resource, 200, versionHeaders(version.version_id, version.last_updated));
    }),
  );

  app.post(
    `${basePath}/${TYPE}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const guard = access(c);
      const operations = guardedOperations(fhir(), guard);
      const body = await readJson(c, ["application/fhir+json", "application/json"]);
      const ifNoneExist = c.req.header("If-None-Exist");
      if (!ifNoneExist) return writeResponse(c, operations.create(type, body), type);
      const outcome = conditionalCreate(operations, conditionalSearch(guard), type, body, ifNoneExist);
      if ("created" in outcome) return writeResponse(c, outcome.created, type);
      const { existing } = outcome;
      return writeResponse(
        c,
        {
          created: false,
          resource: existing.resource,
          versionId: existing.versionId,
          lastUpdated: existing.lastUpdated,
        },
        type,
      );
    }),
  );

  app.get(
    `${basePath}/${TYPE}/${ID}`,
    handle((c) => {
      const record = ops(c).read(c.req.param("type"), c.req.param("id"));
      const headers = versionHeaders(record.version_id, record.last_updated);
      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === `"${record.version_id}"`)
        return c.body(null, 304, headers);
      // HTTP dates have whole seconds, so compare at that precision.
      const ifModifiedSince = Date.parse(c.req.header("If-Modified-Since") ?? "");
      if (!ifNoneMatch && !Number.isNaN(ifModifiedSince))
        if (Math.floor(Date.parse(record.last_updated) / 1000) <= Math.floor(ifModifiedSince / 1000))
          return c.body(null, 304, headers);
      return fhirJson(c, record.resource, 200, headers);
    }),
  );

  // Conditional update and delete address the type with search criteria instead of an id.
  app.put(
    `${basePath}/${TYPE}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const guard = access(c);
      const body = await readJson(c, ["application/fhir+json", "application/json"]);
      const params: Array<[string, string]> = [...new URL(c.req.url).searchParams];
      const result = conditionalUpdate(
        guardedOperations(fhir(), guard),
        conditionalSearch(guard),
        type,
        params,
        body,
        c.req.header("If-Match"),
      );
      return writeResponse(c, result, type);
    }),
  );
  app.delete(
    `${basePath}/${TYPE}`,
    handle((c) => {
      const guard = access(c);
      const params: Array<[string, string]> = [...new URL(c.req.url).searchParams];
      const { versionId } = conditionalDelete(
        guardedOperations(fhir(), guard),
        conditionalSearch(guard),
        c.req.param("type"),
        params,
      );
      return c.body(null, 204, versionId ? { ETag: `W/"${versionId}"` } : {});
    }),
  );

  app.put(
    `${basePath}/${TYPE}/${ID}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const operations = ops(c);
      const body = await readJson(c, ["application/fhir+json", "application/json"]);
      const result = operations.update(type, c.req.param("id"), body, c.req.header("If-Match"));
      return writeResponse(c, result, type);
    }),
  );

  app.patch(
    `${basePath}/${TYPE}/${ID}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const guarded = ops(c);
      const operations = await readJson(c, ["application/json-patch+json"]);
      const result = guarded.patch(type, c.req.param("id"), operations, c.req.header("If-Match"));
      return writeResponse(c, result, type);
    }),
  );

  app.delete(
    `${basePath}/${TYPE}/${ID}`,
    handle((c) => {
      const { versionId } = ops(c).delete(c.req.param("type"), c.req.param("id"), c.req.header("If-Match"));
      return c.body(null, 204, versionId ? { ETag: `W/"${versionId}"` } : {});
    }),
  );
}
