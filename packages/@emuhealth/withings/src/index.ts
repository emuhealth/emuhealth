import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import type { GenerateOptions } from "@emuhealth/fhir-core";
import {
  dailyMetrics,
  daysBetween,
  deviceUsers,
  noise,
  parseClients,
  registerOAuth,
  type DeviceUser,
  type OAuthClient,
  type OAuthServer,
} from "@emuhealth/device-core";

/**
 * Withings API emulator (emuhealth is not affiliated with Withings): OAuth 2.0 (requesttoken), Measure getmeas
 * (weight, blood pressure, heart rate, SpO2), getactivity, Sleep getsummary, User getdevice, and Notify subscriptions
 * that call your callback URL, for synthetic users. As on Withings, every response is HTTP 200 with a status code
 * in the body.
 */
export interface WithingsSeedConfig {
  port?: number;
  /** Registered apps; with none, any client id and redirect URI is accepted. */
  clients?: OAuthClient[];
  /** Users, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
}

const SERVICE_LABEL = "Withings";
const USERS_KEY = "withings.users";
const SUBS_KEY = "withings.subscriptions";
const TTL = 10800;
const runtime = new WeakMap<Store, OAuthServer>();

/** Withings measure types and their units (value times 10 to the power of unit). */
export const MEASURE_TYPES = { weight: 1, height: 4, diastolic: 9, systolic: 10, heartPulse: 11, spo2: 54 } as const;

const users = (store: Store) => {
  let list = store.getData<DeviceUser[]>(USERS_KEY);
  if (!list) {
    list = deviceUsers();
    store.setData(USERS_KEY, list);
  }
  return list;
};
/** Withings user ids are numeric. */
export const withingsUserId = (u: DeviceUser) => String(5_000_000 + Number(u.id));

interface Subscription {
  userid: string;
  callbackurl: string;
  appli: number;
  comment: string;
}
const subscriptions = (store: Store) => {
  let list = store.getData<Subscription[]>(SUBS_KEY);
  if (!list) {
    list = [];
    store.setData(SUBS_KEY, list);
  }
  return list;
};

export function seedFromConfig(store: Store, _baseUrl: string, config: WithingsSeedConfig): void {
  if (config.generate !== undefined) store.setData(USERS_KEY, deviceUsers(config.generate));
  if (config.clients !== undefined) runtime.get(store)?.setClients(parseClients(config.clients, "withings.clients"));
}

type AnyContext = Context<AppEnv>;
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const device = (u: DeviceUser, kind: string) => `synthetic-${kind}-${u.id}`;

/** Weight in the morning, then blood pressure with pulse and SpO2, for each day. */
function measureGroups(u: DeviceUser, day: string) {
  const d = dailyMetrics(u, day);
  const at = (hour: number) => unix(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const group = (
    grpid: number,
    date: number,
    model: string,
    measures: Array<{ value: number; type: number; unit: number }>,
  ) => ({
    grpid,
    attrib: 0,
    date,
    created: date + 30,
    modified: date + 30,
    category: 1,
    deviceid: device(u, model === "Body+" ? "scale" : "bpm"),
    hash_deviceid: device(u, model === "Body+" ? "scale" : "bpm"),
    measures: measures.map((m) => ({ ...m, algo: 0, fm: 3 })),
    model,
    modelid: model === "Body+" ? 5 : 44,
    comment: null,
  });
  const base = Number(day.replace(/-/g, "")) * 10 + Number(u.id);
  return [
    group(base * 2, at(7), "Body+", [{ value: Math.round(d.weightKg * 1000), type: MEASURE_TYPES.weight, unit: -3 }]),
    group(base * 2 + 1, at(8), "BPM Connect", [
      { value: d.diastolic, type: MEASURE_TYPES.diastolic, unit: 0 },
      { value: d.systolic, type: MEASURE_TYPES.systolic, unit: 0 },
      { value: d.restingHeartRate + 6, type: MEASURE_TYPES.heartPulse, unit: 0 },
      { value: 950 + Math.round(noise(u.seed, day, "spo2") * 40), type: MEASURE_TYPES.spo2, unit: -1 },
    ]),
  ];
}

export const withingsPlugin: ServicePlugin = {
  name: "withings",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const oauth = registerOAuth(app, store, {
      key: "withings",
      label: SERVICE_LABEL,
      authorizePath: "/oauth2_user/authorize2",
      defaultScope: "user.info,user.metrics,user.activity",
      accessTtl: TTL,
      users,
    });
    runtime.set(store, oauth);

    /** Withings answers HTTP 200 with a status: 0 for success, other codes for errors. */
    const ok = (c: AnyContext, body: unknown) => c.json({ status: 0, body });
    const fail = (c: AnyContext, status: number, error: string) => c.json({ status, body: {}, error });
    const params = async (c: AnyContext): Promise<Record<string, string>> => {
      const query = Object.fromEntries(new URL(c.req.url).searchParams);
      if (c.req.method !== "POST") return query;
      return { ...query, ...Object.fromEntries(new URLSearchParams(await c.req.text())) };
    };
    const scopes = (scope: string) => scope.split(/[,\s]+/).filter(Boolean);

    // OAuth token: action=requesttoken with grant_type authorization_code or refresh_token.
    app.post("/v2/oauth2", async (c) => {
      const p = await params(c);
      if (p.action !== "requesttoken") return fail(c, 503, "Invalid Params: unknown action");
      const result = oauth.exchange(p);
      if ("error" in result)
        return fail(c, result.error === "invalid_client" ? 601 : 503, `Invalid Params: ${result.description}`);
      const user = users(store).find((u) => u.id === result.access.userId)!;
      return ok(c, {
        userid: withingsUserId(user),
        access_token: result.access.token,
        refresh_token: result.refresh.token,
        expires_in: TTL,
        scope: scopes(result.access.scope).join(","),
        csrf_token: result.access.token.slice(0, 16),
        token_type: "Bearer",
      });
    });

    const api = (
      path: string,
      handlers: Record<
        string,
        { scope: string; run: (c: AnyContext, u: DeviceUser, p: Record<string, string>) => Response }
      >,
    ) => {
      const handle = async (c: AnyContext) => {
        const p = await params(c);
        const handler = handlers[p.action ?? ""];
        if (!handler) return fail(c, 503, `Invalid Params: unknown action ${p.action ?? ""}`);
        const auth = oauth.authenticate(c);
        if (!auth) return fail(c, 401, "XRequestID: Not provided invalid_token: The access token provided is invalid");
        if (!scopes(auth.grant.scope).includes(handler.scope))
          return fail(c, 401, `invalid_scope: The ${handler.scope} scope is required`);
        return handler.run(c, auth.user, p);
      };
      app.get(path, handle);
      app.post(path, handle);
    };
    const ymdRange = (p: Record<string, string>) => {
      const today = new Date().toISOString().slice(0, 10);
      const start =
        p.startdateymd ??
        (p.startdate ? new Date(Number(p.startdate) * 1000).toISOString().slice(0, 10) : undefined) ??
        today;
      const end =
        p.enddateymd ??
        (p.enddate ? new Date(Number(p.enddate) * 1000).toISOString().slice(0, 10) : undefined) ??
        start;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) return undefined;
      return daysBetween(start, end).slice(0, 200);
    };

    api("/measure", {
      getmeas: {
        scope: "user.metrics",
        run: (c, u, p) => {
          const end = p.enddate ? Number(p.enddate) : Math.floor(Date.now() / 1000);
          const start = p.startdate ? Number(p.startdate) : p.lastupdate ? Number(p.lastupdate) : end - 7 * 86400;
          if (Number.isNaN(start) || Number.isNaN(end))
            return fail(c, 503, "Invalid Params: startdate and enddate must be unix times");
          const types = (p.meastypes ?? p.meastype ?? "").split(",").filter(Boolean).map(Number);
          const days = daysBetween(
            new Date(start * 1000).toISOString().slice(0, 10),
            new Date(end * 1000).toISOString().slice(0, 10),
          );
          const groups = days
            .flatMap((day) => measureGroups(u, day))
            .filter((g) => g.date >= start && g.date <= end)
            .map((g) => ({
              ...g,
              measures: types.length ? g.measures.filter((m) => types.includes(m.type)) : g.measures,
            }))
            .filter((g) => g.measures.length > 0)
            .sort((a, b) => b.date - a.date);
          const offset = Number(p.offset ?? 0) || 0;
          const page = groups.slice(offset, offset + 100);
          return ok(c, {
            updatetime: Math.floor(Date.now() / 1000),
            timezone: "UTC",
            measuregrps: page,
            more: offset + 100 < groups.length ? 1 : 0,
            offset: offset + page.length,
          });
        },
      },
    });

    api("/v2/measure", {
      getactivity: {
        scope: "user.activity",
        run: (c, u, p) => {
          const days = ymdRange(p);
          if (!days) return fail(c, 503, "Invalid Params: startdateymd and enddateymd must be YYYY-MM-DD");
          return ok(c, {
            activities: days.map((date) => {
              const d = dailyMetrics(u, date);
              return {
                date,
                timezone: "UTC",
                deviceid: device(u, "tracker"),
                hash_deviceid: device(u, "tracker"),
                brand: 18,
                is_tracker: true,
                steps: d.steps,
                distance: Math.round(d.distanceKm * 1000),
                elevation: Math.round(noise(u.seed, date, "elevation") * 40),
                soft: 9000,
                moderate: Math.round(d.activeMinutes * 0.6 * 60),
                intense: Math.round(d.activeMinutes * 0.4 * 60),
                active: d.activeMinutes * 60,
                calories: Math.round(d.caloriesOut * 0.3),
                totalcalories: d.caloriesOut,
                hr_average: d.restingHeartRate + 14,
                hr_min: d.restingHeartRate - 3,
                hr_max: d.restingHeartRate + 70,
              };
            }),
            more: false,
            offset: 0,
          });
        },
      },
    });

    api("/v2/sleep", {
      getsummary: {
        scope: "user.activity",
        run: (c, u, p) => {
          const days = ymdRange(p);
          if (!days) return fail(c, 503, "Invalid Params: startdateymd and enddateymd must be YYYY-MM-DD");
          return ok(c, {
            series: days.map((date) => {
              const d = dailyMetrics(u, date);
              const asleep = (d.sleep.deepMinutes + d.sleep.lightMinutes + d.sleep.remMinutes) * 60;
              return {
                id: Number(`${u.id}${date.replace(/-/g, "")}`),
                timezone: "UTC",
                model: 32,
                model_id: 63,
                hash_deviceid: device(u, "sleep"),
                startdate: unix(d.sleep.start),
                enddate: unix(d.sleep.end),
                date,
                data: {
                  breathing_disturbances_intensity: Math.round(noise(u.seed, date, "bdi") * 20),
                  deepsleepduration: d.sleep.deepMinutes * 60,
                  durationtosleep: 600,
                  durationtowakeup: 300,
                  hr_average: d.restingHeartRate + 2,
                  hr_max: d.restingHeartRate + 20,
                  hr_min: d.restingHeartRate - 4,
                  lightsleepduration: d.sleep.lightMinutes * 60,
                  remsleepduration: d.sleep.remMinutes * 60,
                  rr_average: 14,
                  sleep_efficiency: Number((d.sleep.efficiency / 100).toFixed(2)),
                  sleep_score: d.sleep.score,
                  total_sleep_time: asleep,
                  total_timeinbed: asleep + d.sleep.awakeMinutes * 60,
                  wakeupcount: Math.round(1 + noise(u.seed, date, "wakeups") * 4),
                  wakeupduration: d.sleep.awakeMinutes * 60,
                },
                created: unix(d.sleep.end) + 600,
                modified: unix(d.sleep.end) + 600,
              };
            }),
            more: false,
            offset: 0,
          });
        },
      },
    });

    api("/v2/user", {
      getdevice: {
        scope: "user.info",
        run: (c, u) =>
          ok(c, {
            devices: [
              {
                type: "Scale",
                battery: "high",
                model: "Body+",
                model_id: 5,
                timezone: "UTC",
                last_session_date: Math.floor(Date.now() / 1000),
                deviceid: device(u, "scale"),
                hash_deviceid: device(u, "scale"),
              },
              {
                type: "Blood Pressure Monitor",
                battery: "medium",
                model: "BPM Connect",
                model_id: 44,
                timezone: "UTC",
                last_session_date: Math.floor(Date.now() / 1000),
                deviceid: device(u, "bpm"),
                hash_deviceid: device(u, "bpm"),
              },
            ],
          }),
      },
    });

    // Notify: subscriptions per user and data category (appli), called back with form data.
    api("/notify", {
      subscribe: {
        scope: "user.info",
        run: (c, u, p) => {
          if (!p.callbackurl || !/^https?:\/\//.test(p.callbackurl))
            return fail(c, 503, "Invalid Params: callbackurl must be an http(s) URL");
          const appli = Number(p.appli ?? 1);
          const list = subscriptions(store);
          if (!list.some((s) => s.userid === withingsUserId(u) && s.callbackurl === p.callbackurl && s.appli === appli))
            list.push({ userid: withingsUserId(u), callbackurl: p.callbackurl, appli, comment: p.comment ?? "" });
          return ok(c, {});
        },
      },
      list: {
        scope: "user.info",
        run: (c, u) =>
          ok(c, {
            profiles: subscriptions(store)
              .filter((s) => s.userid === withingsUserId(u))
              .map((s) => ({ appli: s.appli, callbackurl: s.callbackurl, comment: s.comment, expires: 2147483647 })),
          }),
      },
      revoke: {
        scope: "user.info",
        run: (c, u, p) => {
          const list = subscriptions(store);
          const before = list.length;
          const remaining = list.filter(
            (s) =>
              !(
                s.userid === withingsUserId(u) &&
                s.callbackurl === p.callbackurl &&
                (!p.appli || s.appli === Number(p.appli))
              ),
          );
          store.setData(SUBS_KEY, remaining);
          return remaining.length === before ? fail(c, 294, "No such subscription") : ok(c, {});
        },
      },
    });

    // Send notifications for a user now, as Withings does when new data arrives.
    app.post("/emulator/notify", async (c) => {
      const p = await params(c);
      const user = users(store).find((u) => withingsUserId(u) === p.userid || u.id === p.userid);
      if (!user) return c.json({ error: "Unknown userid" }, 400);
      const appli = Number(p.appli ?? 1);
      const now = Math.floor(Date.now() / 1000);
      const targets = subscriptions(store).filter((s) => s.userid === withingsUserId(user) && s.appli === appli);
      const results = await Promise.all(
        targets.map(async (s) => {
          try {
            const res = await fetch(s.callbackurl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                userid: s.userid,
                startdate: String(now - 3600),
                enddate: String(now),
                appli: String(appli),
              }).toString(),
            });
            return { callbackurl: s.callbackurl, status: res.status };
          } catch (err) {
            return { callbackurl: s.callbackurl, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return c.json({ delivered: results });
    });

    app.get("/_inspector", (c) => {
      const rows = users(store).map(
        (u) =>
          `<tr><td>${withingsUserId(u)}</td><td>${escapeHtml(`${u.firstName} ${u.lastName}`)}</td><td>${subscriptions(store).filter((s) => s.userid === withingsUserId(u)).length}</td></tr>`,
      );
      const body = `<div class="inspector-section"><h2>Users</h2><p>Sign in at /oauth2_user/authorize2 and pick one of these synthetic users.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>userid</th><th>name</th><th>subscriptions</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Withings inspector",
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
    store.setData(SUBS_KEY, []);
  },
};

export default withingsPlugin;
