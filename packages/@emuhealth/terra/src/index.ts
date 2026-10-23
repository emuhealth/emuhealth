import { createHmac, randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderCardPage, renderErrorPage, renderInspectorPage, renderUserButton } from "@emulators/core";
import type { GenerateOptions } from "@emuhealth/fhir-core";
import { dailyMetrics, daysBetween, deviceUsers, glucoseSeries, type DeviceUser } from "@emuhealth/device-core";

/**
 * Terra API emulator (emuhealth is not affiliated with Terra): the aggregator that connects users' wearables and
 * returns normalized data. Widget sessions and a connect page link synthetic users to providers; /v2/daily, sleep,
 * activity, and body return Terra's normalized payloads inline or deliver them to your webhook, signed with
 * terra-signature.
 */
export interface TerraSeedConfig {
  port?: number;
  /** dev-id and x-api-key pairs that authenticate. Default: any non-empty pair. */
  credentials?: Array<{ devId: string; apiKey: string }>;
  /** Your webhook URL and its signing secret. */
  webhook?: { url: string; secret?: string };
  /** Users that can connect, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
}

export const PROVIDERS = ["FITBIT", "OURA", "WITHINGS", "DEXCOM", "GARMIN", "POLAR", "FREESTYLELIBRE"];
const GLUCOSE_PROVIDERS = ["DEXCOM", "FREESTYLELIBRE"];
const SERVICE_LABEL = "Terra";
const DATA_KEY = "terra.data";

interface TerraUser {
  user_id: string;
  provider: string;
  reference_id: string | null;
  scopes: string;
  created_at: string;
  last_webhook_update: string | null;
  active: boolean;
  deviceUser: string;
}
interface Session {
  id: string;
  reference_id: string | null;
  providers: string[];
  success: string | null;
  failure: string | null;
  createdAt: number;
}
interface Data {
  credentials: Array<{ devId: string; apiKey: string }>;
  webhook?: { url: string; secret?: string };
  people: DeviceUser[];
  users: TerraUser[];
  sessions: Map<string, Session>;
  events: Array<{ at: string; type: string; status: number | string }>;
}

function data(store: Store): Data {
  let d = store.getData<Data>(DATA_KEY);
  if (!d) {
    d = { credentials: [], people: deviceUsers(), users: [], sessions: new Map(), events: [] };
    store.setData(DATA_KEY, d);
  }
  return d;
}

/** Terra's webhook signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. */
export function terraSignature(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: TerraSeedConfig): void {
  const d = data(store);
  if (config.credentials !== undefined) {
    if (!Array.isArray(config.credentials) || config.credentials.some((c) => !c?.devId || !c?.apiKey))
      throw new Error("terra.credentials must be an array of { devId, apiKey }");
    d.credentials = config.credentials;
  }
  if (config.webhook !== undefined) {
    if (!config.webhook || typeof config.webhook.url !== "string" || !/^https?:\/\//.test(config.webhook.url))
      throw new Error("terra.webhook.url must be an http(s) URL");
    d.webhook = config.webhook;
  }
  if (config.generate !== undefined) d.people = deviceUsers(config.generate);
}

type AnyContext = Context<AppEnv>;
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");
const view = (u: TerraUser) => ({
  user_id: u.user_id,
  provider: u.provider,
  last_webhook_update: u.last_webhook_update,
  scopes: u.scopes,
  reference_id: u.reference_id,
  created_at: u.created_at,
  active: u.active,
});

// Normalized payloads, one item per day.

function dailyItem(p: DeviceUser, day: string) {
  const d = dailyMetrics(p, day);
  return {
    metadata: {
      start_time: iso(Date.parse(`${day}T00:00:00Z`)),
      end_time: iso(Date.parse(`${day}T00:00:00Z`) + 86_399_000),
      upload_type: 1,
    },
    distance_data: {
      steps: d.steps,
      distance_meters: Math.round(d.distanceKm * 1000),
      floors_climbed: Math.round(d.steps / 2000),
      elevation: { gain_actual_meters: Math.round(d.steps / 300) },
    },
    calories_data: {
      total_burned_calories: d.caloriesOut,
      net_activity_calories: Math.round(d.caloriesOut * 0.3),
      BMR_calories: Math.round(d.caloriesOut * 0.7),
    },
    heart_rate_data: {
      summary: {
        avg_hr_bpm: d.restingHeartRate + 14,
        resting_hr_bpm: d.restingHeartRate,
        max_hr_bpm: d.restingHeartRate + 70,
        min_hr_bpm: d.restingHeartRate - 3,
        avg_hrv_rmssd: d.hrvMs,
      },
    },
    active_durations_data: {
      activity_seconds: d.activeMinutes * 60,
      inactivity_seconds: d.sedentaryMinutes * 60,
      moderate_intensity_seconds: Math.round(d.activeMinutes * 0.6 * 60),
      vigorous_intensity_seconds: Math.round(d.activeMinutes * 0.4 * 60),
    },
    scores: { activity: d.activityScore, recovery: d.readinessScore, sleep: d.sleep.score },
  };
}

function sleepItem(p: DeviceUser, day: string) {
  const d = dailyMetrics(p, day);
  return {
    metadata: {
      start_time: d.sleep.start.replace("Z", "+00:00"),
      end_time: d.sleep.end.replace("Z", "+00:00"),
      is_nap: false,
      upload_type: 1,
    },
    sleep_durations_data: {
      asleep: {
        duration_asleep_state_seconds: (d.sleep.deepMinutes + d.sleep.lightMinutes + d.sleep.remMinutes) * 60,
        duration_deep_sleep_state_seconds: d.sleep.deepMinutes * 60,
        duration_light_sleep_state_seconds: d.sleep.lightMinutes * 60,
        duration_REM_sleep_state_seconds: d.sleep.remMinutes * 60,
      },
      awake: { duration_awake_state_seconds: d.sleep.awakeMinutes * 60 },
      sleep_efficiency: d.sleep.efficiency / 100,
    },
    heart_rate_data: {
      summary: { avg_hr_bpm: d.restingHeartRate + 2, resting_hr_bpm: d.restingHeartRate, avg_hrv_rmssd: d.hrvMs },
    },
    readiness_data: { readiness: d.readinessScore },
  };
}

function activityItem(p: DeviceUser, day: string) {
  const d = dailyMetrics(p, day);
  const start = Date.parse(`${day}T17:30:00Z`);
  return {
    metadata: {
      name: "Walk",
      type: 7,
      start_time: iso(start),
      end_time: iso(start + d.activeMinutes * 60_000),
      summary_id: `${p.id}-${day}`,
      upload_type: 1,
    },
    distance_data: { summary: { steps: Math.round(d.steps * 0.4), distance_meters: Math.round(d.distanceKm * 400) } },
    calories_data: { total_burned_calories: Math.round(d.caloriesOut * 0.15) },
    heart_rate_data: { summary: { avg_hr_bpm: d.restingHeartRate + 45, max_hr_bpm: d.restingHeartRate + 70 } },
  };
}

function bodyItem(p: DeviceUser, day: string, provider: string) {
  const d = dailyMetrics(p, day);
  const start = Date.parse(`${day}T00:00:00Z`);
  return {
    metadata: { start_time: iso(start), end_time: iso(start + 86_399_000) },
    measurements_data: {
      measurements: [
        {
          measurement_time: iso(start + 7 * 3_600_000),
          weight_kg: d.weightKg,
          height_cm: p.heightCm,
          BMI: Number((d.weightKg / (p.heightCm / 100) ** 2).toFixed(1)),
        },
      ],
    },
    blood_pressure_data: {
      blood_pressure_samples: [
        { timestamp: iso(start + 8 * 3_600_000), systolic_bp: d.systolic, diastolic_bp: d.diastolic },
      ],
    },
    ...(GLUCOSE_PROVIDERS.includes(provider)
      ? {
          glucose_data: {
            blood_glucose_samples: glucoseSeries(p, start, start + 86_399_000).map((g) => ({
              timestamp: g.time.replace("Z", "+00:00"),
              blood_glucose_mg_per_dL: g.value,
              glucose_level_flag: 0,
              trend_arrow: 0,
            })),
          },
        }
      : {}),
  };
}

export const terraPlugin: ServicePlugin = {
  name: "terra",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/+$/, "");
    const d = () => data(store);

    /** Deliver a payload to the webhook, signed when a secret is configured. */
    const deliver = async (payload: Record<string, unknown>) => {
      const hook = d().webhook;
      if (!hook) return;
      const body = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(hook.secret ? { "terra-signature": terraSignature(hook.secret, t, body) } : {}),
          },
          body,
        });
        d().events.unshift({ at: new Date().toISOString(), type: String(payload.type), status: res.status });
      } catch (err) {
        d().events.unshift({
          at: new Date().toISOString(),
          type: String(payload.type),
          status: err instanceof Error ? err.message : "error",
        });
      }
      d().events.splice(100);
    };

    const fail = (c: AnyContext, status: number, message: string) =>
      c.json({ status: "error", message }, status as never);
    const api = (handler: (c: AnyContext) => Response | Promise<Response>) => (c: AnyContext) => {
      const devId = c.req.header("dev-id") ?? "";
      const apiKey = c.req.header("x-api-key") ?? "";
      const creds = d().credentials;
      if (!devId || !apiKey || (creds.length > 0 && !creds.some((x) => x.devId === devId && x.apiKey === apiKey)))
        return fail(c, 401, "Unauthorized request. Provide valid dev-id and x-api-key headers.");
      return handler(c);
    };
    const body = async (c: AnyContext) => ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
    const providersFrom = (value: unknown) =>
      String(value ?? PROVIDERS.join(","))
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);

    app.post(
      "/v2/auth/generateWidgetSession",
      api(async (c) => {
        const b = await body(c);
        const providers = providersFrom(b.providers);
        const unknown = providers.filter((p) => !PROVIDERS.includes(p));
        if (unknown.length) return fail(c, 400, `Unsupported providers: ${unknown.join(", ")}`);
        const session: Session = {
          id: randomUUID(),
          reference_id: (b.reference_id as string | undefined) ?? null,
          providers,
          success: (b.auth_success_redirect_url as string | undefined) ?? null,
          failure: (b.auth_failure_redirect_url as string | undefined) ?? null,
          createdAt: Date.now(),
        };
        d().sessions.set(session.id, session);
        return c.json({
          status: "success",
          url: `${origin}/widget/${session.id}`,
          session_id: session.id,
          expires_in: 900,
        });
      }),
    );

    app.post(
      "/v2/auth/authenticateUser",
      api(async (c) => {
        const resource = (c.req.query("resource") ?? "").toUpperCase();
        if (!PROVIDERS.includes(resource)) return fail(c, 400, `Unsupported resource ${resource}`);
        const b = await body(c);
        const session: Session = {
          id: randomUUID(),
          reference_id: (b.reference_id as string | undefined) ?? null,
          providers: [resource],
          success: (b.auth_success_redirect_url as string | undefined) ?? null,
          failure: (b.auth_failure_redirect_url as string | undefined) ?? null,
          createdAt: Date.now(),
        };
        d().sessions.set(session.id, session);
        return c.json({
          status: "success",
          user_id: null,
          auth_url: `${origin}/widget/${session.id}?provider=${resource}`,
        });
      }),
    );

    // The connect page a user sees: pick a provider, then a synthetic person to connect as.
    app.get("/widget/:session", (c) => {
      const session = d().sessions.get(c.req.param("session"));
      if (!session || session.createdAt + 900_000 < Date.now())
        return c.html(
          renderErrorPage("Session expired", "Start the connection again from the app.", SERVICE_LABEL),
          400,
        );
      const provider = c.req.query("provider")?.toUpperCase();
      if (!provider || !session.providers.includes(provider)) {
        const buttons = session.providers.map((p) =>
          renderUserButton({
            letter: p[0],
            login: p,
            name: "Connect this provider",
            formAction: `/widget/${session.id}/provider`,
            hiddenFields: { provider: p },
          }),
        );
        return c.html(
          renderCardPage(
            "Connect a device",
            "Choose the provider to connect. Synthetic data only.",
            buttons.join("\n"),
            SERVICE_LABEL,
          ),
        );
      }
      const buttons = d().people.map((p) =>
        renderUserButton({
          letter: (p.firstName[0] ?? "?").toUpperCase(),
          login: `${p.firstName} ${p.lastName}`,
          name: `Synthetic ${provider} account`,
          formAction: `/widget/${session.id}/connect`,
          hiddenFields: { provider, person: p.id },
        }),
      );
      return c.html(
        renderCardPage(
          `Sign in to ${provider}`,
          "Pick a synthetic account to connect.",
          buttons.join("\n"),
          SERVICE_LABEL,
        ),
      );
    });
    app.post("/widget/:session/provider", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      return c.redirect(
        `/widget/${c.req.param("session")}?provider=${encodeURIComponent(form.get("provider") ?? "")}`,
        303,
      );
    });
    app.post("/widget/:session/connect", async (c) => {
      const session = d().sessions.get(c.req.param("session"));
      const form = new URLSearchParams(await c.req.text());
      const provider = form.get("provider") ?? "";
      const person = d().people.find((p) => p.id === form.get("person"));
      if (!session || !person || !session.providers.includes(provider))
        return c.html(renderErrorPage("Connection failed", "The session or account is not valid.", SERVICE_LABEL), 400);
      d().sessions.delete(session.id);
      const user: TerraUser = {
        user_id: randomUUID(),
        provider,
        reference_id: session.reference_id,
        scopes: "activity,sleep,body,daily",
        created_at: new Date().toISOString(),
        last_webhook_update: null,
        active: true,
        deviceUser: person.id,
      };
      d().users.push(user);
      await deliver({
        type: "auth",
        status: "success",
        user: view(user),
        reference_id: session.reference_id,
        widget_session_id: session.id,
      });
      if (!session.success)
        return c.html(
          renderCardPage(
            "Connected",
            `${escapeHtml(provider)} is connected. You can close this page.`,
            "",
            SERVICE_LABEL,
          ),
        );
      const target = new URL(session.success);
      target.searchParams.set("user_id", user.user_id);
      target.searchParams.set("resource", provider);
      if (session.reference_id) target.searchParams.set("reference_id", session.reference_id);
      return c.redirect(target.toString(), 302);
    });

    const findUser = (c: AnyContext) => {
      const userId = c.req.query("user_id");
      return d().users.find((u) => u.user_id === userId && u.active);
    };

    app.delete(
      "/v2/auth/deauthenticateUser",
      api(async (c) => {
        const user = findUser(c);
        if (!user) return fail(c, 404, "User not found");
        user.active = false;
        await deliver({ type: "deauth", status: "success", user: view(user) });
        return c.json({ status: "success", user: view(user) });
      }),
    );
    app.get(
      "/v2/userInfo",
      api((c) => {
        const ref = c.req.query("reference_id");
        if (ref)
          return c.json({
            status: "success",
            users: d()
              .users.filter((u) => u.reference_id === ref)
              .map(view),
          });
        const user = d().users.find((u) => u.user_id === c.req.query("user_id"));
        if (!user) return fail(c, 404, "User not found");
        return c.json({ status: "success", user: view(user), is_authenticated: user.active });
      }),
    );
    app.get(
      "/v2/subscriptions",
      api((c) =>
        c.json({
          users: d()
            .users.filter((u) => u.active)
            .map(view),
        }),
      ),
    );

    for (const [type, build] of Object.entries({
      daily: (p: DeviceUser, day: string) => dailyItem(p, day),
      sleep: (p: DeviceUser, day: string) => sleepItem(p, day),
      activity: (p: DeviceUser, day: string) => activityItem(p, day),
      body: (p: DeviceUser, day: string, provider: string) => bodyItem(p, day, provider),
    }))
      app.get(
        `/v2/${type}`,
        api(async (c) => {
          const user = findUser(c);
          if (!user) return fail(c, 404, "User not found");
          const start = c.req.query("start_date");
          const end = c.req.query("end_date") ?? start;
          const valid = (v: string | undefined) => v && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10));
          if (!valid(start) || !valid(end)) return fail(c, 400, "start_date and end_date are required, as YYYY-MM-DD");
          const days = daysBetween(start!.slice(0, 10), end!.slice(0, 10)).slice(0, 90);
          const person = d().people.find((p) => p.id === user.deviceUser)!;
          const payload = { type, user: view(user), data: days.map((day) => build(person, day, user.provider)) };
          if (c.req.query("to_webhook") === "false") return c.json({ status: "success", ...payload });
          if (!d().webhook) return fail(c, 400, "No webhook is configured; set terra.webhook or pass to_webhook=false");
          user.last_webhook_update = new Date().toISOString();
          await deliver(payload);
          return c.json({ status: "success", type, user: view(user), message: "Data sent to your webhook" });
        }),
      );

    app.get("/_inspector", (c) => {
      const tab = c.req.query("tab") === "events" ? "events" : "users";
      const tabs = [
        { id: "users", label: `Connected users (${d().users.length})`, href: "/_inspector" },
        { id: "events", label: `Webhook events (${d().events.length})`, href: "/_inspector?tab=events" },
      ];
      const rows =
        tab === "users"
          ? d().users.map(
              (u) =>
                `<tr><td>${escapeHtml(u.user_id)}</td><td>${escapeHtml(u.provider)}</td><td>${escapeHtml(u.reference_id ?? "")}</td><td>${u.active ? "active" : "deauthorized"}</td></tr>`,
            )
          : d().events.map(
              (e) =>
                `<tr><td>${escapeHtml(e.at)}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(String(e.status))}</td><td></td></tr>`,
            );
      const head = tab === "users" ? ["user_id", "provider", "reference_id", "state"] : ["time", "type", "status", ""];
      const html = `<div class="inspector-section"><h2>${tab === "users" ? "Connected users" : "Webhook events"}</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
        rows.length ? rows.join("") : '<tr><td colspan="4"><div class="inspector-empty">Nothing yet</div></td></tr>'
      }</tbody></table></div></div>`;
      return c.html(renderInspectorPage("Terra inspector", tabs, tab, html, SERVICE_LABEL));
    });
  },
  seed(store: Store): void {
    const d = data(store);
    store.setData(DATA_KEY, { ...d, people: deviceUsers(), users: [], sessions: new Map(), events: [] });
  },
};

export default terraPlugin;
