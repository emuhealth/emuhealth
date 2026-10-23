import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { ouraPlugin, seedFromConfig, type OuraSeedConfig } from "../index.js";

const origin = "http://localhost:4121";

async function startService(config?: OuraSeedConfig, scope?: string) {
  const app = new Hono();
  const store = new Store();
  ouraPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  ouraPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const page = await (
    await app.request(
      `${origin}/oauth/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: "http://localhost:3000/cb", response_type: "code", ...(scope ? { scope } : {}) })}`,
    )
  ).text();
  const request = page.match(/name="request" value="([^"]*)"/)![1];
  const consent = await app.request(`${origin}/oauth/authorize/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, user: "3" }).toString(),
  });
  const code = new URL(consent.headers.get("Location")!).searchParams.get("code")!;
  const token = (await (
    await app.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "app",
        client_secret: "s",
        redirect_uri: "http://localhost:3000/cb",
      }).toString(),
    })
  ).json()) as { access_token: string; token_type: string };
  const get = async (path: string, auth = token.access_token) => {
    const res = await app.request(`${origin}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { token, get };
}

describe("Oura API v2", () => {
  it("issues bearer tokens and serves personal info", async () => {
    const { token, get } = await startService();
    expect(token.token_type).toBe("bearer");
    const info = await get("/v2/usercollection/personal_info");
    expect(info.body).toMatchObject({ email: "synthetic-user-3@example.com" });
    expect((await get("/v2/usercollection/personal_info", "nope")).body).toEqual({ detail: "Unauthorized" });
  });

  it("serves daily documents by date range and by id", async () => {
    const { get } = await startService();
    const sleep = await get("/v2/usercollection/daily_sleep?start_date=2025-03-01&end_date=2025-03-04");
    expect(sleep.body.data.map((d: { day: string }) => d.day)).toEqual([
      "2025-03-01",
      "2025-03-02",
      "2025-03-03",
      "2025-03-04",
    ]);
    expect(sleep.body.next_token).toBeNull();
    expect(sleep.body.data[0].contributors).toHaveProperty("deep_sleep");
    const readiness = await get("/v2/usercollection/daily_readiness?start_date=2025-03-04&end_date=2025-03-04");
    expect(readiness.body.data[0].score).toBeGreaterThanOrEqual(60);
    const activity = await get("/v2/usercollection/daily_activity?start_date=2025-03-04&end_date=2025-03-04");
    expect(activity.body.data[0].steps).toBeGreaterThan(1000);
    const periods = await get("/v2/usercollection/sleep?start_date=2025-03-04&end_date=2025-03-04");
    expect(periods.body.data[0].type).toBe("long_sleep");
    const today = new Date().toISOString().slice(0, 10);
    const recent = await get(`/v2/usercollection/daily_sleep?start_date=${today}&end_date=${today}`);
    const one = await get(`/v2/usercollection/daily_sleep/${recent.body.data[0].id}`);
    expect(one.body.day).toBe(today);
    expect((await get("/v2/usercollection/daily_sleep/unknown")).status).toBe(404);
    expect((await get("/v2/usercollection/daily_sleep?start_date=bad")).status).toBe(400);
  });

  it("pages long ranges and serves heart rate", async () => {
    const { get } = await startService();
    const year = await get("/v2/usercollection/daily_activity?start_date=2024-01-01&end_date=2024-12-31");
    expect(year.body.data).toHaveLength(100);
    const next = await get(
      `/v2/usercollection/daily_activity?start_date=2024-01-01&end_date=2024-12-31&next_token=${year.body.next_token}`,
    );
    expect(next.body.data[0].day).toBe("2024-04-10");
    const hr = await get(
      "/v2/usercollection/heartrate?start_datetime=2025-03-04T00:00:00Z&end_datetime=2025-03-04T02:00:00Z",
    );
    expect(hr.body.data).toHaveLength(25);
    expect(hr.body.data[0]).toMatchObject({ source: "sleep" });
  });

  it("checks scopes", async () => {
    const { get } = await startService(undefined, "personal");
    expect((await get("/v2/usercollection/daily_sleep")).status).toBe(403);
    expect((await get("/v2/usercollection/personal_info")).status).toBe(200);
  });
});
