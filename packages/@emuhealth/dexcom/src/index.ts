import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import type { GenerateOptions } from "@emuhealth/fhir-core";
import {
  deviceUsers,
  glucoseSeries,
  noise,
  parseClients,
  registerOAuth,
  type DeviceUser,
  type OAuthClient,
  type OAuthServer,
} from "@emuhealth/device-core";

/**
 * Dexcom API v3 emulator (emuhealth is not affiliated with Dexcom): OAuth 2.0 at /v2/oauth2, and estimated glucose
 * values (EGVs), events, devices, alerts, calibrations, and the data range for synthetic users with a G7 sensor.
 */
export interface DexcomSeedConfig {
  port?: number;
  /** Registered apps; with none, any client id and redirect URI is accepted. */
  clients?: OAuthClient[];
  /** Users, from the synthetic patient generator. Default 5 patients, seed 1. */
  generate?: GenerateOptions;
}

const SERVICE_LABEL = "Dexcom";
const USERS_KEY = "dexcom.users";
const MAX_RANGE_MS = 30 * 86_400_000;
const runtime = new WeakMap<Store, OAuthServer>();

const users = (store: Store) => {
  let list = store.getData<DeviceUser[]>(USERS_KEY);
  if (!list) {
    list = deviceUsers();
    store.setData(USERS_KEY, list);
  }
  return list;
};

/** A stable UUID for a user, as Dexcom's userId. */
const userId = (u: DeviceUser) => {
  const hex = Math.floor(noise(u.seed, "dexcom-user") * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-5e7e-4000-8000-${String(u.seed).padStart(12, "0")}`;
};
/** Dexcom times: systemTime in UTC without a zone, as YYYY-MM-DDThh:mm:ss. */
const dexTime = (iso: string) => iso.slice(0, 19);

export function seedFromConfig(store: Store, _baseUrl: string, config: DexcomSeedConfig): void {
  if (config.generate !== undefined) store.setData(USERS_KEY, deviceUsers(config.generate));
  if (config.clients !== undefined) runtime.get(store)?.setClients(parseClients(config.clients, "dexcom.clients"));
}

type AnyContext = Context<AppEnv>;

export const dexcomPlugin: ServicePlugin = {
  name: "dexcom",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const oauth = registerOAuth(app, store, {
      key: "dexcom",
      label: SERVICE_LABEL,
      authorizePath: "/v2/oauth2/login",
      defaultScope: "offline_access",
      accessTtl: 7200,
      users,
    });
    runtime.set(store, oauth);

    app.post("/v2/oauth2/token", async (c) => {
      const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
      const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const result = oauth.exchange(params, basic);
      if ("error" in result)
        return c.json(
          { error: result.error, error_description: result.description },
          result.error === "invalid_client" ? 401 : 400,
        );
      return c.json({
        access_token: result.access.token,
        expires_in: 7200,
        token_type: "Bearer",
        refresh_token: result.refresh.token,
      });
    });

    /** Dexcom's gateway answers bad tokens with a fault object. */
    const authed = (c: AnyContext, handler: (user: DeviceUser) => Response) => {
      const auth = oauth.authenticate(c);
      if (!auth)
        return c.json(
          {
            fault: {
              faultstring: "Invalid Access Token",
              detail: { errorcode: "keymanagement.service.invalid_access_token" },
            },
          },
          401,
        );
      return handler(auth.user);
    };
    const range = (c: AnyContext) => {
      const start = Date.parse(`${c.req.query("startDate") ?? ""}Z`);
      const end = Date.parse(`${c.req.query("endDate") ?? ""}Z`);
      if (Number.isNaN(start) || Number.isNaN(end))
        return { error: "startDate and endDate are required, as YYYY-MM-DDThh:mm:ss in UTC" };
      if (end <= start) return { error: "endDate must be after startDate" };
      if (end - start > MAX_RANGE_MS)
        return { error: "The time window between startDate and endDate must be 30 days or less" };
      return { start, end };
    };
    const badRequest = (c: AnyContext, message: string) =>
      c.json({ error: "bad_request", error_description: message }, 400);
    const now = () => Date.now();

    app.get("/v3/users/self/egvs", (c) =>
      authed(c, (user) => {
        const r = range(c);
        if ("error" in r) return badRequest(c, r.error!);
        const records = glucoseSeries(user, r.start, Math.min(r.end, now())).map((g) => ({
          recordId: `${userId(user).slice(0, 8)}-${Date.parse(g.time) / 1000}`,
          systemTime: dexTime(g.time),
          displayTime: dexTime(g.time),
          transmitterId: `SYNTX${user.id.padStart(3, "0")}`,
          transmitterTicks: Math.floor(Date.parse(g.time) / 1000) % 864000,
          value: g.value,
          status: null,
          trend: g.trend,
          trendRate: g.trendRate,
          unit: "mg/dL",
          rateUnit: "mg/dL/min",
          displayDevice: "iOS",
          transmitterGeneration: "g7",
        }));
        return c.json({ recordType: "egv", recordVersion: "3.0", userId: userId(user), records });
      }),
    );

    app.get("/v3/users/self/events", (c) =>
      authed(c, (user) => {
        const r = range(c);
        if ("error" in r) return badRequest(c, r.error!);
        const records: Array<Record<string, unknown>> = [];
        for (let day = Math.floor(r.start / 86_400_000) * 86_400_000; day <= Math.min(r.end, now()); day += 86_400_000)
          for (const hour of [8, 13, 19]) {
            const t = day + hour * 3_600_000;
            if (t < r.start || t > r.end) continue;
            const time = dexTime(new Date(t).toISOString());
            records.push({
              recordId: `carbs-${user.id}-${t}`,
              systemTime: time,
              displayTime: time,
              eventStatus: "created",
              eventType: "carbs",
              eventSubType: null,
              value: String(Math.round(30 + noise(user.seed, "carbs", t) * 50)),
              unit: "grams",
              transmitterId: `SYNTX${user.id.padStart(3, "0")}`,
              transmitterGeneration: "g7",
              displayDevice: "iOS",
            });
          }
        return c.json({ recordType: "event", recordVersion: "3.0", userId: userId(user), records });
      }),
    );

    app.get("/v3/users/self/devices", (c) =>
      authed(c, (user) =>
        c.json({
          recordType: "device",
          recordVersion: "3.0",
          userId: userId(user),
          records: [
            {
              lastUploadDate: dexTime(new Date(Math.floor(now() / 300_000) * 300_000).toISOString()),
              transmitterId: `SYNTX${user.id.padStart(3, "0")}`,
              transmitterGeneration: "g7",
              displayDevice: "iOS",
              displayApp: "G7",
              alertSchedules: [
                {
                  alertScheduleSettings: {
                    alertScheduleName: "Default",
                    isEnabled: true,
                    isDefaultSchedule: true,
                    startTime: "00:00",
                    endTime: "00:00",
                    daysOfWeek: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
                  },
                  alertSettings: [
                    { alertName: "high", value: 250, unit: "mg/dL", snooze: 120, enabled: true },
                    { alertName: "low", value: 70, unit: "mg/dL", snooze: 15, enabled: true },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    for (const kind of ["alerts", "calibrations"])
      app.get(`/v3/users/self/${kind}`, (c) =>
        authed(c, (user) => {
          const r = range(c);
          if ("error" in r) return badRequest(c, r.error!);
          return c.json({
            recordType: kind === "alerts" ? "alert" : "calibration",
            recordVersion: "3.0",
            userId: userId(user),
            records: [],
          });
        }),
      );

    app.get("/v3/users/self/dataRange", (c) =>
      authed(c, (user) => {
        const end = Math.floor(now() / 300_000) * 300_000;
        const start = end - 90 * 86_400_000;
        const span = {
          start: {
            systemTime: dexTime(new Date(start).toISOString()),
            displayTime: dexTime(new Date(start).toISOString()),
          },
          end: { systemTime: dexTime(new Date(end).toISOString()), displayTime: dexTime(new Date(end).toISOString()) },
        };
        return c.json({
          recordType: "dataRange",
          recordVersion: "3.0",
          userId: userId(user),
          calibrations: span,
          egvs: span,
          events: span,
        });
      }),
    );

    app.get("/_inspector", (c) => {
      const rows = users(store).map(
        (u) =>
          `<tr><td>${escapeHtml(u.id)}</td><td>${escapeHtml(`${u.firstName} ${u.lastName}`)}</td><td>${escapeHtml(userId(u))}</td><td>SYNTX${u.id.padStart(3, "0")}</td></tr>`,
      );
      const body = `<div class="inspector-section"><h2>Users</h2><p>Sign in at /v2/oauth2/login and pick one of these synthetic users.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>#</th><th>name</th><th>userId</th><th>transmitter</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Dexcom inspector",
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

export default dexcomPlugin;
