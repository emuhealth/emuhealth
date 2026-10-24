import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Hono, ServicePlugin, Store } from "@emulators/core";

// Record and replay (decision 0021): capture a service's HTTP exchanges as NDJSON and replay them against a fresh
// emulator as a regression test, mapping server-assigned ids and ignoring volatile fields.

export interface Exchange {
  method: string;
  /** Path and query. */
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
}

export interface RecordConfig {
  /** NDJSON file to append each exchange to, relative to the working directory. */
  path?: string;
}

const CONTROL_PATH = "/_emulate/recording";
const MAX_EXCHANGES = 10_000;
/** Headers worth keeping: content negotiation and what the service reads. Authorization is never recorded. */
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "prefer",
  "if-match",
  "if-none-match",
  "if-none-exist",
  "if-modified-since",
];
const RESPONSE_HEADERS = ["content-type", "location", "etag", "content-location"];

export function validateRecord(value: unknown, where = "record"): RecordConfig | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be true or { path }`);
  const { path, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error(`${where}: unknown option ${Object.keys(rest).join(", ")}`);
  if (path !== undefined && typeof path !== "string") throw new Error(`${where}.path must be a file path`);
  return { path };
}

const pick = (headers: Headers, names: string[]) =>
  Object.fromEntries(names.flatMap((n) => (headers.get(n) !== null ? [[n, headers.get(n)!]] : [])));

/** A plugin that records exchanges when recording is on, and serves them at /_emulate/recording. */
export function withRecording(plugin: ServicePlugin, initial: RecordConfig | undefined): ServicePlugin {
  return {
    ...plugin,
    register(app: Hono<any>, store: Store, ...rest: any[]) {
      let config = initial;
      const exchanges: Exchange[] = [];
      const file = () => (config?.path ? resolve(config.path) : undefined);

      app.get(CONTROL_PATH, (c) =>
        c.body(exchanges.map((e) => JSON.stringify(e)).join("\n") + (exchanges.length ? "\n" : ""), 200, {
          "Content-Type": "application/x-ndjson",
        }),
      );
      app.put(CONTROL_PATH, async (c) => {
        try {
          config = validateRecord(await c.req.json());
        } catch (error) {
          return c.json({ error: "invalid_recording", message: (error as Error).message }, 400);
        }
        return c.json({ recording: config !== undefined, exchanges: exchanges.length });
      });
      app.delete(CONTROL_PATH, (c) => {
        exchanges.length = 0;
        return c.body(null, 204);
      });

      // Middleware cannot see responses in the core router, so recording wraps the app's fetch handler instead.
      const original = app.fetch.bind(app) as (request: Request, ...args: unknown[]) => Promise<Response> | Response;
      (app as { fetch: unknown }).fetch = async (request: Request, ...args: unknown[]) => {
        const url = new URL(request.url);
        if (!config || url.pathname.startsWith("/_emulate") || url.pathname.startsWith("/_inspector"))
          return original(request, ...args);
        const requestBody = ["GET", "HEAD"].includes(request.method) ? undefined : await request.clone().text();
        const response = await original(request, ...args);
        const contentType = response.headers.get("content-type") ?? "";
        const textual = /json|xml|text|ndjson|er7|hl7/.test(contentType);
        const exchange: Exchange = {
          method: request.method,
          url: url.pathname + url.search,
          requestHeaders: pick(request.headers, REQUEST_HEADERS),
          ...(requestBody ? { requestBody } : {}),
          status: response.status,
          responseHeaders: pick(response.headers, RESPONSE_HEADERS),
          ...(textual ? { responseBody: await response.clone().text() } : {}),
        };
        exchanges.push(exchange);
        if (exchanges.length > MAX_EXCHANGES) exchanges.shift();
        const path = file();
        if (path) {
          mkdirSync(dirname(path), { recursive: true });
          appendFileSync(path, JSON.stringify(exchange) + "\n");
        }
        return response;
      };

      return plugin.register(app as never, store, ...(rest as [never, never, never]));
    },
  };
}

export function parseRecording(text: string): Exchange[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line) as Exchange;
      } catch {
        throw new Error(`Recording line ${i + 1} is not JSON`);
      }
    });
}

/** Keys whose values change from run to run; replay ignores them anywhere in a JSON body. */
export const DEFAULT_IGNORED_KEYS = [
  "lastUpdated",
  "lastModified",
  "date",
  "created",
  "updated",
  "timestamp",
  "time",
  "issued",
  "transactionTime",
  "CreationDateTime",
  "ReferenceNumber",
  "sessionId",
  "access_token",
  "refresh_token",
  "id_token",
];

export interface ReplayDifference {
  index: number;
  method: string;
  url: string;
  problem: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function parseJson(text: string | undefined): Json | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** Pairs of differing "id" values at the same place in two JSON documents: recorded id to replayed id. */
function collectIds(recorded: Json | undefined, replayed: Json | undefined, ids: Map<string, string>): void {
  if (Array.isArray(recorded) && Array.isArray(replayed)) recorded.forEach((v, i) => collectIds(v, replayed[i], ids));
  else if (
    recorded &&
    replayed &&
    typeof recorded === "object" &&
    typeof replayed === "object" &&
    !Array.isArray(recorded) &&
    !Array.isArray(replayed)
  )
    for (const [key, value] of Object.entries(recorded)) {
      const other = (replayed as Record<string, Json>)[key];
      if (key === "id" && typeof value === "string" && typeof other === "string" && value !== other && !ids.has(value))
        ids.set(value, other);
      else collectIds(value, other, ids);
    }
}

const substitute = (text: string, ids: Map<string, string>) =>
  [...ids].reduce((out, [from, to]) => out.split(from).join(to), text);

function normalize(value: Json | undefined, ignored: Set<string>): Json | undefined {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ignored) as Json);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ignored.has(key))
        .map(([key, v]) => [key, normalize(v, ignored) as Json]),
    );
  // Absolute URLs name the host and port the service ran on, which differ between recording and replay.
  if (typeof value === "string") return value.replace(/^https?:\/\/[^/]+/, "");
  return value;
}

/**
 * Replay recorded exchanges against a running service in order and report where the responses differ. Ids the
 * server assigned differently are mapped forward into later requests and comparisons.
 */
export async function replayRecording(
  exchanges: Exchange[],
  baseUrl: string,
  options: { ignore?: string[] } = {},
): Promise<ReplayDifference[]> {
  const ignored = new Set([...DEFAULT_IGNORED_KEYS, ...(options.ignore ?? [])]);
  const ids = new Map<string, string>();
  const differences: ReplayDifference[] = [];
  for (const [index, exchange] of exchanges.entries()) {
    const url = substitute(exchange.url, ids);
    const res = await fetch(new URL(url, baseUrl), {
      method: exchange.method,
      headers: exchange.requestHeaders,
      body: exchange.requestBody === undefined ? undefined : substitute(exchange.requestBody, ids),
    });
    const body = await res.text();
    const report = (problem: string) =>
      differences.push({ index, method: exchange.method, url: exchange.url, problem });
    if (res.status !== exchange.status) {
      report(`status ${res.status}, recorded ${exchange.status}`);
      continue;
    }
    const recorded = parseJson(exchange.responseBody);
    const replayed = parseJson(body);
    if (recorded !== undefined && replayed !== undefined) {
      collectIds(recorded, replayed, ids);
      const location = exchange.responseHeaders.location;
      const replayLocation = res.headers.get("location");
      if (location && replayLocation) {
        const [a, b] = [location.split("/"), replayLocation.split("/")];
        a.forEach(
          (part, i) => part !== b[i] && b[i] && !ids.has(part) && /[-0-9a-f]{6,}/i.test(part) && ids.set(part, b[i]),
        );
      }
      const expected = JSON.stringify(normalize(parseJson(substitute(exchange.responseBody!, ids)), ignored));
      const actual = JSON.stringify(normalize(replayed, ignored));
      if (expected !== actual)
        report(`body differs: recorded ${expected.slice(0, 300)}, replayed ${actual.slice(0, 300)}`);
    }
    // Other bodies (XML, ER7) carry timestamps and reference numbers, so only their status is compared.
  }
  return differences;
}
