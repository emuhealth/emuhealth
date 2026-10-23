import { randomBytes, createHash } from "node:crypto";
import type { AppEnv, Context, Hono, Store } from "@emulators/core";
import { escapeHtml, renderCardPage, renderErrorPage, renderUserButton } from "@emulators/core";
import { generateSyntheticRecords, type GenerateOptions } from "@emuhealth/fhir-core";

/**
 * Shared pieces for the device and wearable emulators (Dexcom, Fitbit, Oura, Withings, Terra): synthetic device
 * users drawn from the patient generator, deterministic sensor data, and an OAuth 2.0 authorization code flow
 * with a consent page built on the shared UI. Synthetic data only.
 */

export interface DeviceUser {
  /** Stable id within an emulator, derived from the synthetic patient. */
  id: string;
  patientId: string;
  firstName: string;
  lastName: string;
  gender: "female" | "male";
  birthDate: string;
  heightCm: number;
  weightKg: number;
  /** Seed for this user's sensor data. */
  seed: number;
}

/** Device users from the synthetic patient generator, with height and weight from their latest vitals. */
export function deviceUsers(options: GenerateOptions = {}): DeviceUser[] {
  const records = generateSyntheticRecords(options);
  const latest = (patientId: string, code: string) => {
    const values = records
      .filter(
        (r) =>
          r.resourceType === "Observation" &&
          (r.subject as { reference?: string }).reference === `Patient/${patientId}` &&
          (r.code as { coding?: Array<{ code?: string }> }).coding?.some((c) => c.code === code),
      )
      .sort((a, b) => String(b.effectiveDateTime).localeCompare(String(a.effectiveDateTime)));
    return (values[0]?.valueQuantity as { value?: number } | undefined)?.value;
  };
  return records
    .filter((r) => r.resourceType === "Patient")
    .map((p, i) => {
      const name = (p.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
      return {
        id: String(i + 1),
        patientId: p.id!,
        firstName: name.given?.[0] ?? "",
        lastName: name.family ?? "",
        gender: p.gender === "female" ? "female" : "male",
        birthDate: String(p.birthDate ?? ""),
        heightCm: latest(p.id!, "8302-2") ?? 170,
        weightKg: latest(p.id!, "29463-7") ?? 72,
        seed: (options.seed ?? 1) * 1000 + i + 1,
      };
    });
}

/** A deterministic number in [0, 1) for a key, so the same user, day, and metric always give the same value. */
export function noise(...parts: Array<string | number>): number {
  const hash = createHash("sha256").update(parts.join("|")).digest();
  return hash.readUInt32BE(0) / 4294967296;
}

const between = (min: number, max: number, r: number) => min + (max - min) * r;

export interface DailyMetrics {
  date: string;
  steps: number;
  distanceKm: number;
  caloriesOut: number;
  activeMinutes: number;
  sedentaryMinutes: number;
  restingHeartRate: number;
  hrvMs: number;
  sleep: {
    start: string;
    end: string;
    deepMinutes: number;
    lightMinutes: number;
    remMinutes: number;
    awakeMinutes: number;
    efficiency: number;
    score: number;
  };
  readinessScore: number;
  activityScore: number;
  weightKg: number;
  systolic: number;
  diastolic: number;
}

/** One day's metrics for a user (date as YYYY-MM-DD, UTC). */
export function dailyMetrics(user: DeviceUser, date: string): DailyMetrics {
  const r = (metric: string) => noise(user.seed, date, metric);
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const steps = Math.round(between(weekend ? 3000 : 5000, weekend ? 12000 : 11000, r("steps")));
  const deep = Math.round(between(50, 110, r("deep")));
  const light = Math.round(between(180, 260, r("light")));
  const rem = Math.round(between(70, 120, r("rem")));
  const awake = Math.round(between(15, 60, r("awake")));
  const bedtime = Date.parse(`${date}T00:00:00Z`) - Math.round(between(60, 150, r("bedtime"))) * 60_000;
  const end = bedtime + (deep + light + rem + awake) * 60_000;
  const efficiency = Math.round(((deep + light + rem) / (deep + light + rem + awake)) * 100);
  return {
    date,
    steps,
    distanceKm: Number((steps * 0.00075).toFixed(2)),
    caloriesOut: Math.round(1600 + steps * 0.045 + user.weightKg * 4),
    activeMinutes: Math.round(steps / 220),
    sedentaryMinutes: Math.round(between(500, 800, r("sedentary"))),
    restingHeartRate: Math.round(between(54, 72, r("rhr"))),
    hrvMs: Math.round(between(25, 75, r("hrv"))),
    sleep: {
      start: new Date(bedtime).toISOString(),
      end: new Date(end).toISOString(),
      deepMinutes: deep,
      lightMinutes: light,
      remMinutes: rem,
      awakeMinutes: awake,
      efficiency,
      score: Math.round(between(62, 92, r("sleepScore"))),
    },
    readinessScore: Math.round(between(60, 95, r("readiness"))),
    activityScore: Math.round(between(55, 98, r("activityScore"))),
    weightKg: Number((user.weightKg + between(-0.8, 0.8, r("weight"))).toFixed(1)),
    systolic: Math.round(between(112, 138, r("sys"))),
    diastolic: Math.round(between(70, 88, r("dia"))),
  };
}

/** Days from start to end inclusive (YYYY-MM-DD). */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface GlucoseReading {
  time: string;
  value: number;
  trend: "doubleUp" | "singleUp" | "fortyFiveUp" | "flat" | "fortyFiveDown" | "singleDown" | "doubleDown";
  trendRate: number;
}

/** Continuous glucose every 5 minutes: a daily rhythm with meal peaks around 08:00, 13:00, and 19:00 UTC. */
export function glucoseSeries(user: DeviceUser, startMs: number, endMs: number): GlucoseReading[] {
  const step = 5 * 60_000;
  const first = Math.ceil(startMs / step) * step;
  const level = (t: number) => {
    const hour = (t % 86_400_000) / 3_600_000;
    const meal = [8, 13, 19].reduce((sum, h) => sum + 60 * Math.exp(-((hour - h - 0.75) ** 2) / 0.5), 0);
    return (
      100 +
      10 * Math.sin((hour / 24) * 2 * Math.PI) +
      meal +
      between(-6, 6, noise(user.seed, "glucose", Math.floor(t / step)))
    );
  };
  const trend = (rate: number): GlucoseReading["trend"] =>
    rate > 3
      ? "doubleUp"
      : rate > 2
        ? "singleUp"
        : rate > 1
          ? "fortyFiveUp"
          : rate >= -1
            ? "flat"
            : rate >= -2
              ? "fortyFiveDown"
              : rate >= -3
                ? "singleDown"
                : "doubleDown";
  const out: GlucoseReading[] = [];
  for (let t = first; t <= endMs; t += step) {
    const value = Math.round(level(t));
    const rate = Number(((value - level(t - step)) / 5).toFixed(1));
    out.push({ time: new Date(t).toISOString(), value, trend: trend(rate), trendRate: rate });
  }
  return out;
}

/** Heart rate samples between two times at a fixed interval in minutes, lower at night. */
export function heartRateSeries(
  user: DeviceUser,
  startMs: number,
  endMs: number,
  intervalMinutes = 5,
): Array<{ time: string; bpm: number }> {
  const step = intervalMinutes * 60_000;
  const out: Array<{ time: string; bpm: number }> = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    const hour = (t % 86_400_000) / 3_600_000;
    const base = hour < 6 ? 56 : hour < 9 || hour > 21 ? 64 : 74;
    out.push({
      time: new Date(t).toISOString(),
      bpm: Math.round(base + between(-5, 12, noise(user.seed, "hr", Math.floor(t / step)))),
    });
  }
  return out;
}

// OAuth 2.0 authorization code flow with a consent page.

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

export interface OAuthGrant {
  token: string;
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scope: string;
  expiresAt: number;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge?: string;
  userId?: string;
  createdAt: number;
}

export interface OAuthOptions {
  /** Store key prefix, for example "dexcom". */
  key: string;
  /** Label in the consent page header, for example "Dexcom". */
  label: string;
  /** Authorization page path, for example /v2/oauth2/login. */
  authorizePath: string;
  /** Default scope when the request has none. */
  defaultScope: string;
  /** Access token lifetime in seconds. */
  accessTtl: number;
  users: (store: Store) => DeviceUser[];
}

export interface OAuthServer {
  /** Exchange a code or refresh token; returns the new grant or an error message. */
  exchange(
    params: Record<string, string>,
    basicAuth?: string,
  ): { access: OAuthGrant; refresh: OAuthGrant } | { error: string; description: string };
  /** The user and grant for an Authorization: Bearer header, if valid. */
  authenticate(c: Context<AppEnv>): { user: DeviceUser; grant: OAuthGrant } | undefined;
  /** Register clients (with none, any client id and redirect URI is accepted). */
  setClients(clients: OAuthClient[]): void;
  /** Revoke a token. */
  revoke(token: string): void;
}

export function registerOAuth(app: Hono<AppEnv>, store: Store, options: OAuthOptions): OAuthServer {
  const k = (name: string) => `${options.key}.oauth.${name}`;
  const map = <V>(name: string): Map<string, V> => {
    let m = store.getData<Map<string, V>>(k(name));
    if (!m) {
      m = new Map();
      store.setData(k(name), m);
    }
    return m;
  };
  const clients = () => store.getData<OAuthClient[]>(k("clients")) ?? [];
  const findClient = (id: string) =>
    clients().length === 0 ? { client_id: id } : clients().find((c) => c.client_id === id);
  const id = () => randomBytes(24).toString("base64url");

  const page = (c: Context<AppEnv>, requestId: string) => {
    const req = map<PendingAuthorization>("requests").get(requestId)!;
    const buttons = options.users(store).map((u) =>
      renderUserButton({
        letter: (u.firstName[0] ?? "?").toUpperCase(),
        login: `${u.firstName} ${u.lastName}`,
        name: `Synthetic user ${u.id}`,
        email: `Allow access to: ${req.scope}`,
        formAction: `${options.authorizePath.replace(/\/+$/, "")}/consent`,
        hiddenFields: { request: requestId, user: u.id },
      }),
    );
    return c.html(
      renderCardPage(
        `Sign in to ${options.label}`,
        `${escapeHtml(req.clientId)} is asking for access to your data. Pick a synthetic user to allow it.`,
        buttons.join("\n") || '<p class="empty">No synthetic users.</p>',
        options.label,
      ),
    );
  };

  app.get(options.authorizePath, (c) => {
    const q = (name: string) => c.req.query(name) ?? "";
    const client = findClient(q("client_id"));
    if (!q("client_id") || !client)
      return c.html(renderErrorPage("Unknown app", "The client_id is missing or not registered.", options.label), 400);
    const redirectUri = q("redirect_uri");
    if (!/^https?:\/\//.test(redirectUri) || (client.redirect_uris && !client.redirect_uris.includes(redirectUri)))
      return c.html(
        renderErrorPage(
          "Redirect URI mismatch",
          "The redirect_uri is missing or not registered for this app.",
          options.label,
        ),
        400,
      );
    if (q("response_type") && q("response_type") !== "code") {
      const target = new URL(redirectUri);
      target.searchParams.set("error", "unsupported_response_type");
      if (q("state")) target.searchParams.set("state", q("state"));
      return c.redirect(target.toString(), 302);
    }
    const requestId = id();
    map<PendingAuthorization>("requests").set(requestId, {
      clientId: q("client_id"),
      redirectUri,
      scope: q("scope") || options.defaultScope,
      state: q("state"),
      codeChallenge: q("code_challenge") || undefined,
      createdAt: Date.now(),
    });
    return page(c, requestId);
  });

  app.post(`${options.authorizePath.replace(/\/+$/, "")}/consent`, async (c) => {
    const form = new URLSearchParams(await c.req.text());
    const req = map<PendingAuthorization>("requests").get(form.get("request") ?? "");
    if (!req || req.createdAt + 30 * 60_000 < Date.now())
      return c.html(
        renderErrorPage("Authorization expired", "Start the sign-in again from the app.", options.label),
        400,
      );
    map<PendingAuthorization>("requests").delete(form.get("request")!);
    const user = options.users(store).find((u) => u.id === form.get("user"));
    const target = new URL(req.redirectUri);
    if (!user) target.searchParams.set("error", "access_denied");
    else {
      const code = id();
      map<PendingAuthorization & { code: string }>("codes").set(code, {
        ...req,
        userId: user.id,
        code,
        createdAt: Date.now(),
      });
      target.searchParams.set("code", code);
    }
    if (req.state) target.searchParams.set("state", req.state);
    return c.redirect(target.toString(), 302);
  });

  const grant = (clientId: string, userId: string, scope: string) => {
    const access: OAuthGrant = {
      token: id(),
      kind: "access",
      clientId,
      userId,
      scope,
      expiresAt: Date.now() + options.accessTtl * 1000,
    };
    const refresh: OAuthGrant = {
      token: id(),
      kind: "refresh",
      clientId,
      userId,
      scope,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    map<OAuthGrant>("tokens").set(access.token, access);
    map<OAuthGrant>("tokens").set(refresh.token, refresh);
    return { access, refresh };
  };

  return {
    exchange(params, basicAuth) {
      let clientId = params.client_id ?? "";
      let secret = params.client_secret;
      if (basicAuth) {
        const [bid, bsecret] = Buffer.from(basicAuth, "base64").toString("utf8").split(":");
        clientId = clientId || bid;
        secret = secret ?? bsecret;
      }
      const client = findClient(clientId);
      if (!client) return { error: "invalid_client", description: "The client is not registered." };
      if (client.client_secret && client.client_secret !== secret)
        return { error: "invalid_client", description: "Client authentication failed." };
      if (params.grant_type === "authorization_code") {
        const codes = map<PendingAuthorization & { code: string }>("codes");
        const issued = codes.get(params.code ?? "");
        codes.delete(params.code ?? "");
        if (!issued || issued.createdAt + 10 * 60_000 < Date.now())
          return { error: "invalid_grant", description: "The authorization code is invalid or expired." };
        if (issued.clientId !== clientId)
          return { error: "invalid_grant", description: "The code was issued to another client." };
        if (params.redirect_uri && params.redirect_uri !== issued.redirectUri)
          return { error: "invalid_grant", description: "redirect_uri does not match the authorization request." };
        if (
          issued.codeChallenge &&
          createHash("sha256")
            .update(params.code_verifier ?? "")
            .digest("base64url") !== issued.codeChallenge
        )
          return { error: "invalid_grant", description: "code_verifier does not match the code_challenge." };
        return grant(clientId, issued.userId!, issued.scope);
      }
      if (params.grant_type === "refresh_token") {
        const stored = map<OAuthGrant>("tokens").get(params.refresh_token ?? "");
        if (!stored || stored.kind !== "refresh" || stored.clientId !== clientId)
          return { error: "invalid_grant", description: "The refresh token is invalid." };
        map<OAuthGrant>("tokens").delete(stored.token);
        return grant(clientId, stored.userId, stored.scope);
      }
      return { error: "unsupported_grant_type", description: "Use authorization_code or refresh_token." };
    },
    authenticate(c) {
      const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const g = token ? map<OAuthGrant>("tokens").get(token) : undefined;
      if (!g || g.kind !== "access" || g.expiresAt < Date.now()) return undefined;
      const user = options.users(store).find((u) => u.id === g.userId);
      return user ? { user, grant: g } : undefined;
    },
    setClients(list) {
      store.setData(k("clients"), list);
    },
    revoke(token) {
      map<OAuthGrant>("tokens").delete(token);
    },
  };
}

/** Validate and normalize oauth client config for an emulator's seed config. */
export function parseClients(value: unknown, key: string): OAuthClient[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value.map((c, i) => {
    if (!c || typeof c.client_id !== "string" || !c.client_id) throw new Error(`${key}[${i}].client_id is required`);
    if (
      c.redirect_uris !== undefined &&
      (!Array.isArray(c.redirect_uris) || c.redirect_uris.some((u: unknown) => typeof u !== "string"))
    )
      throw new Error(`${key}[${i}].redirect_uris must be an array of URLs`);
    return { client_id: c.client_id, client_secret: c.client_secret, redirect_uris: c.redirect_uris };
  });
}
