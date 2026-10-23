import { randomUUID } from "node:crypto";
import type { Context, Hono, Store } from "@emulators/core";
import { FhirError, operationOutcome } from "./outcome.js";
import { processBundle } from "./bundle.js";
import { buildCapabilityStatement } from "./capability.js";
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

function fhirJson(c: AnyContext, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return c.body(JSON.stringify(body), status, { "Content-Type": FHIR_JSON, ...headers });
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
      if (err instanceof FhirError) return fhirJson(c, err.toOutcome(), err.status);
      const message = err instanceof Error ? err.message : "Internal server error";
      return fhirJson(c, operationOutcome("exception", message, "fatal"), 500);
    }
  };
}

/** Mount the FHIR R4 REST API (create, read, vread, update, patch, delete, history, search, batch, transaction). */
export function registerFhirRoutes(app: Hono<any>, store: Store, options: FhirRouteOptions): void {
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const base = `${options.baseUrl.replace(/\/+$/, "")}${basePath}`;
  const fhir = () => getFhirStore(store);

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

  function historyBundle(params: Array<[string, string]>, type?: string, id?: string): FhirResource {
    const query = new URLSearchParams(params);
    const since = query.get("_since") ?? undefined;
    const { total, entries } = fhir().listHistory({
      type,
      id,
      since,
      count: parseCount(query.get("_count") ?? undefined),
    });
    if (type && id && total === 0 && since === undefined)
      throw new FhirError(404, "not-found", `${type}/${id} is not known`);
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
    return fhirJson(c, historyBundle([...new URL(c.req.url).searchParams], type, id));
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
    return fhirJson(c, searchBundle(type, params, strict));
  }

  function searchBundle(type: string, params: Array<[string, string]>, strict = false): FhirResource {
    const parsed = parseSearch(type, params, { strict });
    const store = fhir();
    const ctx: SearchContext = {
      resolve: (t, id) => store.find(t, id),
      listCurrent: (t) => store.listCurrent(t),
    };
    const { total, matches } = runSearch(store.listCurrent(type), parsed, ctx);
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
    const included = resolveIncludes(page, parsed, ctx);
    return {
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
  }

  async function bundle(c: AnyContext): Promise<Response> {
    const body = await readJson(c, ["application/fhir+json", "application/json"]);
    const prefer = c.req.header("Prefer");
    return fhirJson(
      c,
      processBundle(body, {
        fhir: fhir(),
        base,
        prefer,
        search: (type, params) => searchBundle(type, params),
        history: (params, type, id) => historyBundle(params, type, id),
        snapshot: () => {
          const saved = store.snapshot();
          return () => store.restore(saved);
        },
      }),
    );
  }

  app.get(
    `${basePath}/metadata`,
    handle((c) =>
      fhirJson(c, buildCapabilityStatement({ base, software: options.software, description: options.description })),
    ),
  );

  function everything(c: AnyContext, id?: string): Response {
    const store = fhir();
    // Instance level: 404 or 410 when the patient is unknown or deleted.
    const ids = id ? [store.read("Patient", id).resource.id!] : store.listCurrent("Patient").map((p) => p.id!);
    const query = new URL(c.req.url).searchParams;
    const count = Math.min(parseCount(query.get("_count") ?? undefined) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = parseCount(query.get("_getpagesoffset") ?? undefined) ?? 0;
    const records = patientEverything(store, ids, {
      since: query.get("_since") ?? undefined,
      types: parseTypes(query.get("_type") ?? undefined),
    });
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
      const version = fhir().vread(c.req.param("type"), c.req.param("id"), c.req.param("vid"));
      return fhirJson(c, version.resource, 200, versionHeaders(version.version_id, version.last_updated));
    }),
  );

  app.post(
    `${basePath}/${TYPE}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const result = fhir().create(type, await readJson(c, ["application/fhir+json", "application/json"]));
      return writeResponse(c, result, type);
    }),
  );

  app.get(
    `${basePath}/${TYPE}/${ID}`,
    handle((c) => {
      const record = fhir().read(c.req.param("type"), c.req.param("id"));
      const headers = versionHeaders(record.version_id, record.last_updated);
      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === `"${record.version_id}"`)
        return c.body(null, 304, headers);
      return fhirJson(c, record.resource, 200, headers);
    }),
  );

  app.put(
    `${basePath}/${TYPE}/${ID}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const body = await readJson(c, ["application/fhir+json", "application/json"]);
      const result = fhir().update(type, c.req.param("id"), body, c.req.header("If-Match"));
      return writeResponse(c, result, type);
    }),
  );

  app.patch(
    `${basePath}/${TYPE}/${ID}`,
    handle(async (c) => {
      const type = c.req.param("type");
      const operations = await readJson(c, ["application/json-patch+json"]);
      const result = fhir().patch(type, c.req.param("id"), operations, c.req.header("If-Match"));
      return writeResponse(c, result, type);
    }),
  );

  app.delete(
    `${basePath}/${TYPE}/${ID}`,
    handle((c) => {
      const { versionId } = fhir().delete(c.req.param("type"), c.req.param("id"), c.req.header("If-Match"));
      return c.body(null, 204, versionId ? { ETag: `W/"${versionId}"` } : {});
    }),
  );
}
