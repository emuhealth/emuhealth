import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fitbitPlugin, seedFromConfig, type FitbitSeedConfig } from "../index.js";

const origin = "http://localhost:4120";

async function startService(config?: FitbitSeedConfig, scope = "activity heartrate profile sleep weight") {
  const app = new Hono();
  const store = new Store();
  fitbitPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  fitbitPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const page = await (
    await app.request(
      `${origin}/oauth2/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: "http://localhost:3000/cb", response_type: "code", scope })}`,
    )
  ).text();
  const request = page.match(/name="request" value="([^"]*)"/)![1];
  const consent = await app.request(`${origin}/oauth2/authorize/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, user: "2" }).toString(),
  });
  const code = new URL(consent.headers.get("Location")!).searchParams.get("code")!;
  const token = (await (
    await app.request(`${origin}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from("app:secret").toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/cb",
      }).toString(),
    })
  ).json()) as { access_token: string; user_id: string; expires_in: number };
  const get = async (path: string, auth = token.access_token) => {
    const res = await app.request(`${origin}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  return { token, get };
}

describe("Fitbit Web API", () => {
  it("issues tokens with the user id and checks them", async () => {
    const { token, get } = await startService();
    expect(token).toMatchObject({ user_id: "SYN002", expires_in: 28800 });
    const profile = await get("/1/user/-/profile.json");
    expect(profile.body.user.encodedId).toBe("SYN002");
    expect(profile.headers.get("fitbit-rate-limit-limit")).toBe("150");
    expect((await get("/1/user/SYN002/profile.json")).status).toBe(200);
    expect((await get("/1/user/SYN001/profile.json")).status).toBe(403);
    const bad = await get("/1/user/-/profile.json", "nope");
    expect(bad.body).toMatchObject({ success: false, errors: [{ errorType: "invalid_token" }] });
  });

  it("serves activity summaries and time series", async () => {
    const { get } = await startService();
    const day = await get("/1/user/-/activities/date/2025-03-04.json");
    expect(day.body.summary.steps).toBeGreaterThan(1000);
    const week = await get("/1/user/-/activities/steps/date/2025-03-04/7d.json");
    expect(week.body["activities-steps"]).toHaveLength(7);
    expect(week.body["activities-steps"][6]).toEqual({ dateTime: "2025-03-04", value: String(day.body.summary.steps) });
    const range = await get("/1/user/-/activities/steps/date/2025-03-01/2025-03-04.json");
    expect(range.body["activities-steps"]).toHaveLength(4);
    expect((await get("/1/user/-/activities/steps/date/2025-03-04/2w.json")).status).toBe(400);
  });

  it("serves heart rate with intraday, sleep stages, and weight", async () => {
    const { get } = await startService();
    const heart = await get("/1/user/-/activities/heart/date/2025-03-04/1d.json");
    expect(heart.body["activities-heart"][0].value.heartRateZones).toHaveLength(4);
    const intraday = await get("/1/user/-/activities/heart/date/2025-03-04/1d/15min.json");
    expect(intraday.body["activities-heart-intraday"].dataset).toHaveLength(96);
    const sleep = await get("/1.2/user/-/sleep/date/2025-03-04.json");
    expect(sleep.body.sleep[0]).toMatchObject({ dateOfSleep: "2025-03-04", type: "stages", isMainSleep: true });
    expect(sleep.body.summary.totalMinutesAsleep).toBe(sleep.body.sleep[0].minutesAsleep);
    expect((await get("/1.2/user/-/sleep/date/2025-03-01/2025-03-04.json")).body.sleep).toHaveLength(4);
    expect((await get("/1/user/-/body/log/weight/date/2025-03-04.json")).body.weight[0].source).toBe("Aria");
  });

  it("enforces scopes", async () => {
    const { get } = await startService(undefined, "profile");
    const denied = await get("/1.2/user/-/sleep/date/2025-03-04.json");
    expect(denied.status).toBe(403);
    expect(denied.body.errors[0].errorType).toBe("insufficient_scope");
  });
});
