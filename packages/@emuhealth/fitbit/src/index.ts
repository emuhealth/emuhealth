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
 * Fitbit Web API emulator (emuhealth is not affiliated with Google or Fitbit): OAuth 2.0, profile, daily activity
 * summaries and time series, heart rate (with intraday), sleep stages, and weight logs for synthetic users, with
 * Fitbit's scopes, error envelope, and rate limit headers.
 */
export interface FitbitSeedConfig {
  port?: number;
  /** Registered apps; with none, any client id and redirect URI is accepted. */
  clients?: OAuthClient[];
  /** Users, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
}

const SERVICE_LABEL = "Fitbit";
const USERS_KEY = "fitbit.users";
const TTL = 28800;
const runtime = new WeakMap<Store, OAuthServer>();

const users = (store: Store) => {
  let list = store.getData<DeviceUser[]>(USERS_KEY);
  if (!list) {
    list = deviceUsers();
    store.setData(USERS_KEY, list);
  }
  return list;
};

/** Fitbit's encoded user id: six characters. */
export const encodedId = (u: DeviceUser) => `SYN${u.id.padStart(3, "0")}`;

export function seedFromConfig(store: Store, _baseUrl: string, config: FitbitSeedConfig): void {
  if (config.generate !== undefined) store.setData(USERS_KEY, deviceUsers(config.generate));
  if (config.clients !== undefined) runtime.get(store)?.setClients(parseClients(config.clients, "fitbit.clients"));
}

type AnyContext = Context<AppEnv>;

const PERIODS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "1w": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
};

const fitbitTime = (iso: string) => iso.replace("Z", "").slice(0, 23);

export const fitbitPlugin: ServicePlugin = {
  name: "fitbit",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const oauth = registerOAuth(app, store, {
      key: "fitbit",
      label: SERVICE_LABEL,
      authorizePath: "/oauth2/authorize",
      defaultScope: "activity heartrate profile sleep weight",
      accessTtl: TTL,
      users,
    });
    runtime.set(store, oauth);

    const errors = (c: AnyContext, status: number, errorType: string, message: string) =>
      c.json({ errors: [{ errorType, message }], success: false }, status as never);

    app.post("/oauth2/token", async (c) => {
      const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const result = oauth.exchange(params, basic);
      if ("error" in result)
        return errors(c, result.error === "invalid_client" ? 401 : 400, result.error, result.description);
      const user = users(store).find((u) => u.id === result.access.userId)!;
      return c.json({
        access_token: result.access.token,
        expires_in: TTL,
        refresh_token: result.refresh.token,
        scope: result.access.scope,
        token_type: "Bearer",
        user_id: encodedId(user),
      });
    });
    app.post("/oauth2/revoke", async (c) => {
      const token = new URLSearchParams(await c.req.text()).get("token");
      if (token) oauth.revoke(token);
      return c.json({});
    });

    /** Authenticate, check the scope, and add Fitbit's rate limit headers. */
    const api = (scope: string, handler: (c: AnyContext, user: DeviceUser) => Response) => (c: AnyContext) => {
      const auth = oauth.authenticate(c);
      if (!auth)
        return errors(
          c,
          401,
          "invalid_token",
          "Access token invalid or expired. Visit https://dev.fitbit.com/docs/oauth2 for more information on the Fitbit Web API authorization process.",
        );
      const owner = c.req.param("user");
      if (owner && owner !== "-" && owner !== encodedId(auth.user))
        return errors(
          c,
          403,
          "insufficient_permissions",
          "This application does not have permission to access this user's data.",
        );
      if (!auth.grant.scope.split(/\s+/).includes(scope))
        return errors(
          c,
          403,
          "insufficient_scope",
          `This application does not have permission to access ${scope} data.`,
        );
      const response = handler(c, auth.user);
      response.headers.set("fitbit-rate-limit-limit", "150");
      response.headers.set("fitbit-rate-limit-remaining", "149");
      response.headers.set("fitbit-rate-limit-reset", String(3600 - Math.floor((Date.now() / 1000) % 3600)));
      return response;
    };
    const validDate = (d: string | undefined) =>
      d === "today" ? new Date().toISOString().slice(0, 10) : d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
    /** The days a request covers: {date}/{period} or {date}/{end date}. */
    const days = (c: AnyContext): string[] | undefined => {
      const date = validDate(c.req.param("date"));
      const period = c.req.param("period") ?? "1d";
      if (!date) return undefined;
      const end = validDate(period);
      if (end) return end >= date ? daysBetween(date, end) : undefined;
      const count = PERIODS[period];
      if (!count) return undefined;
      const start = new Date(Date.parse(`${date}T00:00:00Z`) - (count - 1) * 86_400_000).toISOString().slice(0, 10);
      return daysBetween(start, date);
    };
    const invalidDate = (c: AnyContext) =>
      errors(
        c,
        400,
        "validation",
        "Invalid date or period. Use yyyy-MM-dd or today, and a period such as 1d, 7d, 30d, 1w, 1m, 3m, 6m, or 1y.",
      );
    const age = (u: DeviceUser) => Math.floor((Date.now() - Date.parse(u.birthDate)) / (365.25 * 86_400_000));

    app.get(
      "/1/user/:user/profile.json",
      api("profile", (c, u) =>
        c.json({
          user: {
            encodedId: encodedId(u),
            displayName: u.firstName,
            firstName: u.firstName,
            lastName: u.lastName,
            fullName: `${u.firstName} ${u.lastName}`,
            gender: u.gender.toUpperCase(),
            dateOfBirth: u.birthDate,
            age: age(u),
            height: u.heightCm,
            weight: u.weightKg,
            heightUnit: "METRIC",
            weightUnit: "METRIC",
            timezone: "UTC",
            offsetFromUTCMillis: 0,
            memberSince: "2020-01-01",
            locale: "en_US",
            avatar: "",
            averageDailySteps: dailyMetrics(u, new Date().toISOString().slice(0, 10)).steps,
          },
        }),
      ),
    );

    app.get(
      "/1/user/:user/activities/date/:date.json",
      api("activity", (c, u) => {
        const date = validDate(c.req.param("date"));
        if (!date) return invalidDate(c);
        const d = dailyMetrics(u, date);
        return c.json({
          activities: [],
          goals: { activeMinutes: 30, caloriesOut: 2200, distance: 8.05, floors: 10, steps: 10000 },
          summary: {
            activityCalories: Math.round(d.caloriesOut * 0.35),
            caloriesBMR: Math.round(d.caloriesOut * 0.65),
            caloriesOut: d.caloriesOut,
            distances: [
              { activity: "total", distance: d.distanceKm },
              { activity: "tracker", distance: d.distanceKm },
            ],
            fairlyActiveMinutes: Math.round(d.activeMinutes * 0.4),
            lightlyActiveMinutes: 180 + Math.round(noise(u.seed, date, "light") * 80),
            sedentaryMinutes: d.sedentaryMinutes,
            veryActiveMinutes: Math.round(d.activeMinutes * 0.6),
            steps: d.steps,
            restingHeartRate: d.restingHeartRate,
          },
        });
      }),
    );

    for (const resource of ["steps", "distance", "calories", "minutesSedentary", "minutesVeryActive"]) {
      const handler = api("activity", (c, u) => {
        const list = days(c);
        if (!list) return invalidDate(c);
        const value = (date: string) => {
          const d = dailyMetrics(u, date);
          return {
            steps: d.steps,
            distance: d.distanceKm,
            calories: d.caloriesOut,
            minutesSedentary: d.sedentaryMinutes,
            minutesVeryActive: Math.round(d.activeMinutes * 0.6),
          }[resource];
        };
        return c.json({
          [`activities-${resource}`]: list.map((dateTime) => ({ dateTime, value: String(value(dateTime)) })),
        });
      });
      app.get(`/1/user/:user/activities/${resource}/date/:date/:period.json`, handler);
    }

    const heartDay = (u: DeviceUser, date: string) => {
      const d = dailyMetrics(u, date);
      const zone = (name: string, min: number, max: number, share: number) => ({
        name,
        min,
        max,
        minutes: Math.round(1440 * share),
        caloriesOut: Number((d.caloriesOut * share).toFixed(1)),
      });
      return {
        dateTime: date,
        value: {
          customHeartRateZones: [],
          heartRateZones: [
            zone("Out of Range", 30, 100, 0.88),
            zone("Fat Burn", 100, 140, 0.08),
            zone("Cardio", 140, 170, 0.03),
            zone("Peak", 170, 220, 0.01),
          ],
          restingHeartRate: d.restingHeartRate,
        },
      };
    };
    const heart = api("heartrate", (c, u) => {
      const detail = c.req.param("detail");
      if (detail) {
        const date = validDate(c.req.param("date"));
        const interval = { "1sec": 1, "1min": 1, "5min": 5, "15min": 15 }[detail];
        if (!date || !interval) return invalidDate(c);
        const start = Date.parse(`${date}T00:00:00Z`);
        const samples = heartRateSeries(u, start, start + 86_400_000 - 1, interval);
        return c.json({
          "activities-heart": [heartDay(u, date)],
          "activities-heart-intraday": {
            dataset: samples.map((s) => ({ time: s.time.slice(11, 19), value: s.bpm })),
            datasetInterval: interval,
            datasetType: detail === "1sec" ? "second" : "minute",
          },
        });
      }
      const list = days(c);
      if (!list) return invalidDate(c);
      return c.json({ "activities-heart": list.map((date) => heartDay(u, date)) });
    });
    app.get("/1/user/:user/activities/heart/date/:date/:period/:detail.json", heart);
    app.get("/1/user/:user/activities/heart/date/:date/:period.json", heart);

    const sleepLog = (u: DeviceUser, date: string) => {
      const d = dailyMetrics(u, date).sleep;
      const asleep = d.deepMinutes + d.lightMinutes + d.remMinutes;
      const inBed = asleep + d.awakeMinutes;
      const stage = (minutes: number, count: number) => ({ count, minutes, thirtyDayAvgMinutes: minutes });
      // A simple stage sequence for levels.data: light, deep, light, rem, wake, repeated through the night.
      const sequence: Array<[string, number]> = [];
      let t = Date.parse(d.start);
      const cycles = 4;
      for (let i = 0; i < cycles; i++)
        for (const [level, total] of [
          ["light", d.lightMinutes],
          ["deep", d.deepMinutes],
          ["rem", d.remMinutes],
          ["wake", d.awakeMinutes],
        ] as const) {
          const seconds = Math.round((total / cycles) * 60);
          sequence.push([level, seconds]);
        }
      return {
        dateOfSleep: date,
        duration: inBed * 60_000,
        efficiency: d.efficiency,
        startTime: fitbitTime(d.start),
        endTime: fitbitTime(d.end),
        infoCode: 0,
        isMainSleep: true,
        logId: Number(`${u.seed}${date.replace(/-/g, "")}`) % 1e12,
        logType: "auto_detected",
        minutesAfterWakeup: 0,
        minutesAsleep: asleep,
        minutesAwake: d.awakeMinutes,
        minutesToFallAsleep: 0,
        timeInBed: inBed,
        type: "stages",
        levels: {
          summary: {
            deep: stage(d.deepMinutes, 4),
            light: stage(d.lightMinutes, 20),
            rem: stage(d.remMinutes, 6),
            wake: stage(d.awakeMinutes, 18),
          },
          data: sequence.map(([level, seconds]) => {
            const entry = { dateTime: fitbitTime(new Date(t).toISOString()), level, seconds };
            t += seconds * 1000;
            return entry;
          }),
        },
      };
    };
    app.get(
      "/1.2/user/:user/sleep/date/:date.json",
      api("sleep", (c, u) => {
        const date = validDate(c.req.param("date"));
        if (!date) return invalidDate(c);
        const log = sleepLog(u, date);
        return c.json({
          sleep: [log],
          summary: {
            stages: {
              deep: log.levels.summary.deep.minutes,
              light: log.levels.summary.light.minutes,
              rem: log.levels.summary.rem.minutes,
              wake: log.levels.summary.wake.minutes,
            },
            totalMinutesAsleep: log.minutesAsleep,
            totalSleepRecords: 1,
            totalTimeInBed: log.timeInBed,
          },
        });
      }),
    );
    app.get(
      "/1.2/user/:user/sleep/date/:date/:end.json",
      api("sleep", (c, u) => {
        const start = validDate(c.req.param("date"));
        const end = validDate(c.req.param("end"));
        if (!start || !end || end < start || daysBetween(start, end).length > 100)
          return errors(c, 400, "validation", "The date range must be 100 days or less.");
        return c.json({
          sleep: daysBetween(start, end)
            .reverse()
            .map((date) => sleepLog(u, date)),
        });
      }),
    );

    app.get(
      "/1/user/:user/body/log/weight/date/:date.json",
      api("weight", (c, u) => {
        const date = validDate(c.req.param("date"));
        if (!date) return invalidDate(c);
        const d = dailyMetrics(u, date);
        return c.json({
          weight: [
            {
              bmi: Number((d.weightKg / (u.heightCm / 100) ** 2).toFixed(2)),
              date,
              logId: Number(`${u.seed}${date.replace(/-/g, "")}`) % 1e12,
              source: "Aria",
              time: "07:00:00",
              weight: d.weightKg,
            },
          ],
        });
      }),
    );

    app.get("/_inspector", (c) => {
      const rows = users(store).map(
        (u) =>
          `<tr><td>${encodedId(u)}</td><td>${escapeHtml(`${u.firstName} ${u.lastName}`)}</td><td>${dailyMetrics(u, new Date().toISOString().slice(0, 10)).steps}</td></tr>`,
      );
      const body = `<div class="inspector-section"><h2>Users</h2><p>Sign in at /oauth2/authorize and pick one of these synthetic users.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>encodedId</th><th>name</th><th>steps today</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Fitbit inspector",
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

export default fitbitPlugin;
