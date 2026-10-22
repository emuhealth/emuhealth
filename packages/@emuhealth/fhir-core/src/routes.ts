import { randomUUID } from "node:crypto";
import type { Context, Hono, Store } from "@emulators/core";
import { FhirError, operationOutcome } from "./outcome.js";
import { parseSearch, resolveIncludes, runSearch, type SearchContext } from "./search.js";
import { getFhirStore, type FhirHistoryRecord, type WriteResult } from "./store.js";

export const FHIR_JSON = "application/fhir+json; charset=utf-8";

export interface FhirRouteOptions {
  /** Public base URL of the server, without a trailing slash (for example http://localhost:4100). */
  baseUrl: string;
  /** Path the FHIR API is mounted under, for example "/api/FHIR/R4". Defaults to the server root. */
  basePath?: string;
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

/** Mount the FHIR R4 REST API (create, read, vread, update, patch, delete, history). */
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

  function historyBundle(c: AnyContext, total: number, entries: FhirHistoryRecord[]): Response {
    return fhirJson(c, {
      resourceType: "Bundle",
      id: randomUUID(),
      meta: { lastUpdated: new Date().toISOString() },
      type: "history",
      total,
      link: [{ relation: "self", url: `${base}${c.req.path.slice(basePath.length)}${new URL(c.req.url).search}` }],
      entry: entries.map((h) => ({
        fullUrl: `${base}/${h.resource_type}/${h.fhir_id}`,
        ...(h.resource ? { resource: h.resource } : {}),
        request: { method: h.method, url: h.method === "POST" ? h.resource_type : `${h.resource_type}/${h.fhir_id}` },
        response: {
          status: STATUS_TEXT[h.method],
          etag: `W/"${h.version_id}"`,
          lastModified: h.last_updated,
        },
      })),
    });
  }

  function history(c: AnyContext, type?: string, id?: string): Response {
    const { total, entries } = fhir().listHistory({
      type,
      id,
      since: c.req.query("_since"),
      count: parseCount(c.req.query("_count")),
    });
    if (type && id && total === 0 && c.req.query("_since") === undefined)
      throw new FhirError(404, "not-found", `${type}/${id} is not known`);
    return historyBundle(c, total, entries);
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
    return fhirJson(c, {
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
    });
  }

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
