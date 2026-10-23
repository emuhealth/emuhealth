import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import type { GenerateOptions } from "@emuhealth/fhir-core";
import {
  dailyMetrics,
  daysBetween,
  deviceUsers,
  heartRateSeries,
  noise,
  parseClients,
  registerOAuth,
  type DeviceUser,
  type OAuthClient,
  type OAuthServer,
} from "@emuhealth/device-core";

/**
 * Oura API v2 emulator (emuhealth is not affiliated with Oura): OAuth 2.0 and the /v2/usercollection documents
 * (personal info, daily sleep, activity, readiness, SpO2, sleep periods, heart rate) for synthetic users, with
 * Oura's next_token paging, scopes, and error shape.
 */
export interface OuraSeedConfig {
  port?: number;
  /** Registered apps; with none, any client id and redirect URI is accepted. */
  clients?: OAuthClient[];
  /** Users, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
}

const SERVICE_LABEL = "Oura";
const USERS_KEY = "oura.users";
const TTL = 86400;
const PAGE = 100;
const runtime = new WeakMap<Store, OAuthServer>();

const users = (store: Store) => {
  let list = store.getData<DeviceUser[]>(USERS_KEY);
  if (!list) {
    list = deviceUsers();
    store.setData(USERS_KEY, list);
  }
  return list;
};

export function seedFromConfig(store: Store, _baseUrl: string, config: OuraSeedConfig): void {
  if (config.generate !== undefined) store.setData(USERS_KEY, deviceUsers(config.generate));
  if (config.clients !== undefined) runtime.get(store)?.setClients(parseClients(config.clients, "oura.clients"));
}

type AnyContext = Context<AppEnv>;
type Doc = Record<string, unknown> & { id: string };

/** A stable document id for a user, collection, and day. */
const docId = (u: DeviceUser, collection: string, day: string) => {
  const hex = (n: number) =>
    Math.floor(noise(u.seed, collection, day, n) * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${hex(1)}-${hex(2).slice(0, 4)}-4${hex(3).slice(0, 3)}-8${hex(4).slice(0, 3)}-${hex(5)}${hex(6).slice(0, 4)}`;
};
const score = (u: DeviceUser, day: string, name: string) => Math.round(60 + noise(u.seed, day, name) * 38);
const midnight = (day: string) => `${day}T00:00:00+00:00`;

function dailySleep(u: DeviceUser, day: string): Doc {
  const d = dailyMetrics(u, day);
  return {
    id: docId(u, "daily_sleep", day),
    contributors: {
      deep_sleep: score(u, day, "deep"),
      efficiency: d.sleep.efficiency,
      latency: score(u, day, "latency"),
      rem_sleep: score(u, day, "rem"),
      restfulness: score(u, day, "restfulness"),
      timing: score(u, day, "timing"),
      total_sleep: score(u, day, "total"),
    },
    day,
    score: d.sleep.score,
    timestamp: midnight(day),
  };
}

function dailyActivity(u: DeviceUser, day: string): Doc {
  const d = dailyMetrics(u, day);
  const active = Math.round(d.caloriesOut * 0.3);
  return {
    id: docId(u, "daily_activity", day),
    class_5_min: null,
    score: d.activityScore,
    active_calories: active,
    average_met_minutes: Number((1.2 + noise(u.seed, day, "met") * 0.6).toFixed(2)),
    contributors: {
      meet_daily_targets: score(u, day, "targets"),
      move_every_hour: score(u, day, "move"),
      recovery_time: score(u, day, "recovery"),
      stay_active: score(u, day, "stay"),
      training_frequency: score(u, day, "frequency"),
      training_volume: score(u, day, "volume"),
    },
    equivalent_walking_distance: Math.round(d.distanceKm * 1000),
    high_activity_met_minutes: Math.round(d.activeMinutes * 0.4 * 7),
    high_activity_time: Math.round(d.activeMinutes * 0.4 * 60),
    inactivity_alerts: Math.round(noise(u.seed, day, "alerts") * 3),
    low_activity_met_minutes: 180,
    low_activity_time: 14400,
    medium_activity_met_minutes: Math.round(d.activeMinutes * 0.6 * 4),
    medium_activity_time: Math.round(d.activeMinutes * 0.6 * 60),
    meters_to_target: Math.max(0, 8000 - Math.round(d.distanceKm * 1000)),
    non_wear_time: 0,
    resting_time: (d.sleep.deepMinutes + d.sleep.lightMinutes + d.sleep.remMinutes) * 60,
    sedentary_met_minutes: Math.round(d.sedentaryMinutes / 2),
    sedentary_time: d.sedentaryMinutes * 60,
    steps: d.steps,
    target_calories: 500,
    target_meters: 8000,
    total_calories: d.caloriesOut,
    day,
    timestamp: midnight(day),
  };
}

function dailyReadiness(u: DeviceUser, day: string): Doc {
  const d = dailyMetrics(u, day);
  return {
    id: docId(u, "daily_readiness", day),
    contributors: {
      activity_balance: score(u, day, "activity_balance"),
      body_temperature: score(u, day, "body_temperature"),
      hrv_balance: score(u, day, "hrv_balance"),
      previous_day_activity: score(u, day, "previous_day_activity"),
      previous_night: score(u, day, "previous_night"),
      recovery_index: score(u, day, "recovery_index"),
      resting_heart_rate: score(u, day, "resting_heart_rate"),
      sleep_balance: score(u, day, "sleep_balance"),
    },
    day,
    score: d.readinessScore,
    temperature_deviation: Number((noise(u.seed, day, "temp") * 0.6 - 0.3).toFixed(2)),
    temperature_trend_deviation: Number((noise(u.seed, day, "trend") * 0.4 - 0.2).toFixed(2)),
    timestamp: midnight(day),
  };
}

function sleepPeriod(u: DeviceUser, day: string): Doc {
  const d = dailyMetrics(u, day);
  const asleep = (d.sleep.deepMinutes + d.sleep.lightMinutes + d.sleep.remMinutes) * 60;
  return {
    id: docId(u, "sleep", day),
    average_breath: Number((13 + noise(u.seed, day, "breath") * 3).toFixed(1)),
    average_heart_rate: d.restingHeartRate + 4,
    average_hrv: d.hrvMs,
    awake_time: d.sleep.awakeMinutes * 60,
    bedtime_end: d.sleep.end.replace("Z", "+00:00").replace(".000", ""),
    bedtime_start: d.sleep.start.replace("Z", "+00:00").replace(".000", ""),
    day,
    deep_sleep_duration: d.sleep.deepMinutes * 60,
    efficiency: d.sleep.efficiency,
    latency: Math.round(300 + noise(u.seed, day, "latency_s") * 900),
    light_sleep_duration: d.sleep.lightMinutes * 60,
    low_battery_alert: false,
    lowest_heart_rate: d.restingHeartRate - 4,
    readiness_score_delta: null,
    rem_sleep_duration: d.sleep.remMinutes * 60,
    restless_periods: Math.round(100 + noise(u.seed, day, "restless") * 200),
    sleep_score_delta: null,
    time_in_bed: asleep + d.sleep.awakeMinutes * 60,
    total_sleep_duration: asleep,
    type: "long_sleep",
  };
}

function dailySpo2(u: DeviceUser, day: string): Doc {
  return {
    id: docId(u, "daily_spo2", day),
    day,
    spo2_percentage: { average: Number((95 + noise(u.seed, day, "spo2") * 3.5).toFixed(3)) },
    breathing_disturbance_index: Math.round(noise(u.seed, day, "bdi") * 12),
  };
}

const COLLECTIONS: Record<string, { scope: string; build: (u: DeviceUser, day: string) => Doc }> = {
  daily_sleep: { scope: "daily", build: dailySleep },
  daily_activity: { scope: "daily", build: dailyActivity },
  daily_readiness: { scope: "daily", build: dailyReadiness },
  sleep: { scope: "daily", build: sleepPeriod },
  daily_spo2: { scope: "spo2", build: dailySpo2 },
};

export const ouraPlugin: ServicePlugin = {
  name: "oura",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const oauth = registerOAuth(app, store, {
      key: "oura",
      label: SERVICE_LABEL,
      authorizePath: "/oauth/authorize",
      defaultScope: "email personal daily heartrate workout tag session spo2",
      accessTtl: TTL,
      users,
    });
    runtime.set(store, oauth);

    app.post("/oauth/token", async (c) => {
      const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const result = oauth.exchange(params, basic);
      if ("error" in result)
        return c.json(
          { error: result.error, error_description: result.description },
          result.error === "invalid_client" ? 401 : 400,
        );
      return c.json({
        token_type: "bearer",
        access_token: result.access.token,
        expires_in: TTL,
        refresh_token: result.refresh.token,
      });
    });

    const detail = (c: AnyContext, status: number, message: unknown) => c.json({ detail: message }, status as never);
    const api = (scope: string, handler: (c: AnyContext, user: DeviceUser) => Response) => (c: AnyContext) => {
      const auth = oauth.authenticate(c);
      if (!auth) return detail(c, 401, "Unauthorized");
      if (!auth.grant.scope.split(/\s+/).includes(scope))
        return detail(c, 403, `Access to this resource requires the ${scope} scope.`);
      return handler(c, auth.user);
    };
    const dateParam = (c: AnyContext, name: string) => {
      const value = c.req.query(name);
      if (value === undefined) return undefined;
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    };
    const validation = (c: AnyContext, field: string) =>
      detail(c, 400, [
        {
          loc: ["query", field],
          msg: "Input should be a valid date in YYYY-MM-DD format",
          type: "date_from_datetime_parsing",
        },
      ]);

    /** Paged list over days: start_date (default end_date minus one day) to end_date (default today). */
    const list = (build: (u: DeviceUser, day: string) => Doc) => (c: AnyContext, user: DeviceUser) => {
      const end = dateParam(c, "end_date");
      const start = dateParam(c, "start_date");
      if (end === null) return validation(c, "end_date");
      if (start === null) return validation(c, "start_date");
      const last = end ?? new Date().toISOString().slice(0, 10);
      const first = start ?? new Date(Date.parse(`${last}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const days = first <= last ? daysBetween(first, last) : [];
      const offset = Number(Buffer.from(c.req.query("next_token") ?? "", "base64url").toString() || 0) || 0;
      const page = days.slice(offset, offset + PAGE).map((day) => build(user, day));
      const next = offset + PAGE < days.length ? Buffer.from(String(offset + PAGE)).toString("base64url") : null;
      return c.json({ data: page, next_token: next });
    };

    app.get(
      "/v2/usercollection/personal_info",
      api("personal", (c, u) =>
        c.json({
          id: docId(u, "personal_info", "0"),
          age: Math.floor((Date.now() - Date.parse(u.birthDate)) / (365.25 * 86_400_000)),
          weight: u.weightKg,
          height: Number((u.heightCm / 100).toFixed(2)),
          biological_sex: u.gender,
          email: `synthetic-user-${u.id}@example.com`,
        }),
      ),
    );

    for (const [name, { scope, build }] of Object.entries(COLLECTIONS)) {
      app.get(`/v2/usercollection/${name}`, api(scope, list(build)));
      app.get(
        `/v2/usercollection/${name}/:id`,
        api(scope, (c, u) => {
          // Documents are generated per day; look back a year for the id.
          const today = new Date().toISOString().slice(0, 10);
          const start = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
          const day = daysBetween(start, today).find((d) => docId(u, name, d) === c.req.param("id"));
          return day ? c.json(build(u, day)) : detail(c, 404, "Document not found");
        }),
      );
    }

    app.get(
      "/v2/usercollection/heartrate",
      api("heartrate", (c, u) => {
        const parse = (name: string) => {
          const value = c.req.query(name);
          return value === undefined ? undefined : Date.parse(value);
        };
        const end = parse("end_datetime") ?? Date.now();
        const start = parse("start_datetime") ?? end - 86_400_000;
        if (Number.isNaN(start) || Number.isNaN(end))
          return detail(c, 400, [
            { loc: ["query", "start_datetime"], msg: "Input should be a valid datetime", type: "datetime_parsing" },
          ]);
        if (end - start > 30 * 86_400_000) return detail(c, 400, "The time range must be 30 days or less.");
        const samples = heartRateSeries(u, start, end, 5).map((s) => {
          const hour = Number(s.time.slice(11, 13));
          return {
            bpm: s.bpm,
            source: hour < 6 ? "sleep" : hour < 8 || hour > 22 ? "rest" : "awake",
            timestamp: s.time.replace(".000Z", "+00:00"),
          };
        });
        const offset = Number(Buffer.from(c.req.query("next_token") ?? "", "base64url").toString() || 0) || 0;
        const next = offset + 5000 < samples.length ? Buffer.from(String(offset + 5000)).toString("base64url") : null;
        return c.json({ data: samples.slice(offset, offset + 5000), next_token: next });
      }),
    );

    app.get(
      "/v2/usercollection/workout",
      api("workout", (c) => c.json({ data: [], next_token: null })),
    );
    app.get(
      "/v2/usercollection/session",
      api("session", (c) => c.json({ data: [], next_token: null })),
    );
    app.get(
      "/v2/usercollection/ring_configuration",
      api("personal", (c, u) =>
        c.json({
          data: [
            {
              id: docId(u, "ring", "0"),
              color: "silver",
              design: "heritage",
              firmware_version: "2.9.21",
              hardware_type: "gen3",
              set_up_at: "2024-01-01T00:00:00+00:00",
              size: 9,
            },
          ],
          next_token: null,
        }),
      ),
    );

    app.get("/_inspector", (c) => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = users(store).map(
        (u) =>
          `<tr><td>${escapeHtml(u.id)}</td><td>${escapeHtml(`${u.firstName} ${u.lastName}`)}</td><td>${dailySleep(u, today).score}</td><td>${dailyReadiness(u, today).score}</td></tr>`,
      );
      const body = `<div class="inspector-section"><h2>Users</h2><p>Sign in at /oauth/authorize and pick one of these synthetic users.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>#</th><th>name</th><th>sleep score today</th><th>readiness today</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Oura inspector",
          [{ id: "users", label: "Users", href: "/_inspector" }],
          "users",
          body,
          SERVICE_LABEL,
        ),
      );
    });
  },
  seed(store: Store): void {
    store.setData(USERS_KEY, deviceUsers());
  },
};

export default ouraPlugin;
