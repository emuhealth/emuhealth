import type { Context, Hono, ServicePlugin, Store } from "@emulators/core";

// Fault injection (decision 0020): latency, rate limits, outages, and expired tokens for any service, from its
// `faults` seed config or at runtime through /_emulate/faults. It wraps the service plugin, so no emulator changes.

export interface FaultConfig {
  /** Delay every matching response by this many milliseconds, plus up to jitterMs more. */
  latency?: { ms: number; jitterMs?: number };
  /** Allow this many matching requests per window, then answer 429 with Retry-After. */
  rateLimit?: { requests: number; windowSeconds: number };
  /** Answer matching requests with this status (default 503) at this probability (default 1). */
  outage?: { status?: number; probability?: number; retryAfterSeconds?: number };
  /** Answer requests that carry a bearer token with 401 invalid_token at this probability (default 1). */
  expiredTokens?: { probability?: number };
  /** Apply faults only to paths that start with one of these. Default: every path except /_emulate and /_inspector. */
  paths?: string[];
}

const CONTROL_PATH = "/_emulate/faults";

export function validateFaults(value: unknown, where = "faults"): FaultConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const config = value as Record<string, any>;
  const known = ["latency", "rateLimit", "outage", "expiredTokens", "paths"];
  const unknown = Object.keys(config).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown option ${unknown.join(", ")}`);
  const nonNegative = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new Error(`${where}.${name} must be a number of 0 or more`);
  };
  const probability = (v: unknown, name: string) => {
    if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1))
      throw new Error(`${where}.${name} must be from 0 to 1`);
  };
  if (config.latency !== undefined) {
    nonNegative(config.latency?.ms, "latency.ms");
    if (config.latency.jitterMs !== undefined) nonNegative(config.latency.jitterMs, "latency.jitterMs");
  }
  if (config.rateLimit !== undefined) {
    if (!Number.isInteger(config.rateLimit?.requests) || config.rateLimit.requests < 0)
      throw new Error(`${where}.rateLimit.requests must be an integer of 0 or more`);
    if (!Number.isFinite(config.rateLimit.windowSeconds) || config.rateLimit.windowSeconds <= 0)
      throw new Error(`${where}.rateLimit.windowSeconds must be more than 0`);
  }
  if (config.outage !== undefined) {
    if (config.outage === null || typeof config.outage !== "object")
      throw new Error(`${where}.outage must be an object`);
    const status = config.outage.status ?? 503;
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new Error(`${where}.outage.status must be 400 to 599`);
    probability(config.outage.probability, "outage.probability");
    if (config.outage.retryAfterSeconds !== undefined)
      nonNegative(config.outage.retryAfterSeconds, "outage.retryAfterSeconds");
  }
  if (config.expiredTokens !== undefined) probability(config.expiredTokens?.probability, "expiredTokens.probability");
  if (
    config.paths !== undefined &&
    (!Array.isArray(config.paths) || config.paths.some((p: unknown) => typeof p !== "string"))
  )
    throw new Error(`${where}.paths must be an array of path prefixes`);
  return config as FaultConfig;
}

/** A service's seed config without the keys the CLI handles (faults, record), which the service does not read. */
export function withoutCliKeys(config: Record<string, unknown>): Record<string, unknown> {
  if (!("faults" in config) && !("record" in config)) return config;
  const { faults: _faults, record: _record, ...rest } = config;
  return rest;
}

/** The body a failure gets: an OperationOutcome for FHIR clients, a JSON error otherwise. */
function failure(c: Context, status: number, code: string, message: string, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  c.header("X-Emulate-Fault", code);
  if (/fhir\+json/.test(c.req.header("Accept") ?? "") || /fhir\+json/.test(c.req.header("Content-Type") ?? ""))
    return c.body(
      JSON.stringify({
        resourceType: "OperationOutcome",
        issue: [
          {
            severity: "error",
            code: status === 401 ? "login" : status === 429 ? "throttled" : "transient",
            diagnostics: message,
          },
        ],
      }),
      status as never,
      { "Content-Type": "application/fhir+json; charset=utf-8" },
    );
  return c.json({ error: code, message }, status as never);
}

/** A plugin that registers fault injection ahead of the service's own routes. */
export function withFaults(plugin: ServicePlugin, initial: FaultConfig | undefined): ServicePlugin {
  return {
    ...plugin,
    register(app: Hono<any>, store: Store, ...rest: any[]) {
      let config = initial;
      let window = { start: 0, count: 0 };
      const applies = (path: string) =>
        !path.startsWith("/_emulate") &&
        !path.startsWith("/_inspector") &&
        (!config?.paths?.length || config.paths.some((prefix) => path.startsWith(prefix)));

      app.get(CONTROL_PATH, (c) => c.json(config ?? {}));
      app.put(CONTROL_PATH, async (c) => {
        try {
          config = validateFaults(await c.req.json()) ?? undefined;
        } catch (error) {
          return c.json({ error: "invalid_faults", message: (error as Error).message }, 400);
        }
        window = { start: 0, count: 0 };
        return c.json(config ?? {});
      });
      app.delete(CONTROL_PATH, (c) => {
        config = undefined;
        window = { start: 0, count: 0 };
        return c.body(null, 204);
      });

      app.use("*", async (c, next) => {
        const path = new URL(c.req.url).pathname;
        if (!config || !applies(path)) return next();
        if (config.latency)
          await new Promise((r) =>
            setTimeout(r, config!.latency!.ms + Math.random() * (config!.latency!.jitterMs ?? 0)),
          );
        if (config.rateLimit) {
          const now = Date.now();
          const length = config.rateLimit.windowSeconds * 1000;
          if (now - window.start >= length) window = { start: now, count: 0 };
          window.count++;
          if (window.count > config.rateLimit.requests) {
            const retry = Math.max(1, Math.ceil((window.start + length - now) / 1000));
            return failure(c, 429, "rate_limited", "Too many requests (emulated rate limit)", {
              "Retry-After": String(retry),
            });
          }
        }
        if (config.outage && Math.random() < (config.outage.probability ?? 1)) {
          const retry = config.outage.retryAfterSeconds;
          return failure(
            c,
            config.outage.status ?? 503,
            "outage",
            "Service unavailable (emulated outage)",
            retry === undefined ? {} : { "Retry-After": String(retry) },
          );
        }
        if (
          config.expiredTokens &&
          /^Bearer\s/i.test(c.req.header("Authorization") ?? "") &&
          Math.random() < (config.expiredTokens.probability ?? 1)
        )
          return failure(c, 401, "invalid_token", "The access token expired (emulated)", {
            "WWW-Authenticate": 'Bearer error="invalid_token", error_description="The access token expired"',
          });
        return next();
      });

      return plugin.register(app as never, store, ...(rest as [never, never, never]));
    },
  };
}
