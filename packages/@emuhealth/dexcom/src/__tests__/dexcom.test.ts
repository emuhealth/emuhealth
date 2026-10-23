import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { dexcomPlugin, seedFromConfig, type DexcomSeedConfig } from "../index.js";

const origin = "http://localhost:4119";

async function startService(config?: DexcomSeedConfig) {
  const app = new Hono();
  const store = new Store();
  dexcomPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  dexcomPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const page = await (
    await app.request(
      `${origin}/v2/oauth2/login?client_id=app&redirect_uri=http://localhost:3000/cb&response_type=code&scope=offline_access&state=s`,
    )
  ).text();
  const request = page.match(/name="request" value="([^"]*)"/)![1];
  const consent = await app.request(`${origin}/v2/oauth2/login/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, user: "1" }).toString(),
  });
  const code = new URL(consent.headers.get("Location")!).searchParams.get("code")!;
  const token = (await (
    await app.request(`${origin}/v2/oauth2/token`, {
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
  ).json()) as { access_token: string; refresh_token: string; expires_in: number };
  const get = async (path: string, auth = token.access_token) => {
    const res = await app.request(`${origin}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, token, get };
}

describe("Dexcom API v3", () => {
  it("issues tokens through the login and consent flow", async () => {
    const { token, get } = await startService();
    expect(token.expires_in).toBe(7200);
    expect(token.refresh_token).toBeTruthy();
    const bad = await get("/v3/users/self/devices", "nope");
    expect(bad.status).toBe(401);
    expect(bad.body.fault.faultstring).toBe("Invalid Access Token");
  });

  it("returns 5 minute EGVs for a window of up to 30 days", async () => {
    const { get } = await startService();
    const egvs = await get("/v3/users/self/egvs?startDate=2025-03-04T00:00:00&endDate=2025-03-04T06:00:00");
    expect(egvs.status).toBe(200);
    expect(egvs.body).toMatchObject({ recordType: "egv", recordVersion: "3.0" });
    expect(egvs.body.records).toHaveLength(73);
    expect(egvs.body.records[0]).toMatchObject({
      systemTime: "2025-03-04T00:00:00",
      unit: "mg/dL",
      transmitterGeneration: "g7",
    });
    const again = await get("/v3/users/self/egvs?startDate=2025-03-04T00:00:00&endDate=2025-03-04T06:00:00");
    expect(again.body.records).toEqual(egvs.body.records);
    expect((await get("/v3/users/self/egvs?startDate=2025-01-01T00:00:00&endDate=2025-03-01T00:00:00")).status).toBe(
      400,
    );
    expect((await get("/v3/users/self/egvs")).status).toBe(400);
  });

  it("returns events, devices, and the data range", async () => {
    const { get } = await startService();
    const events = await get("/v3/users/self/events?startDate=2025-03-04T00:00:00&endDate=2025-03-05T00:00:00");
    expect(events.body.records.map((e: { eventType: string }) => e.eventType)).toEqual(["carbs", "carbs", "carbs"]);
    expect((await get("/v3/users/self/devices")).body.records[0].transmitterGeneration).toBe("g7");
    expect((await get("/v3/users/self/dataRange")).body.egvs.start.systemTime).toBeTruthy();
  });

  it("checks registered clients", async () => {
    const app = new Hono();
    const store = new Store();
    dexcomPlugin.register(app as never, store, new WebhookDispatcher(), origin);
    dexcomPlugin.seed?.(store, origin);
    seedFromConfig(store, origin, {
      clients: [{ client_id: "registered", redirect_uris: ["http://localhost:3000/cb"] }],
    });
    const unknown = await app.request(
      `${origin}/v2/oauth2/login?client_id=other&redirect_uri=http://localhost:3000/cb`,
    );
    expect(unknown.status).toBe(400);
    const known = await app.request(
      `${origin}/v2/oauth2/login?client_id=registered&redirect_uri=http://localhost:3000/cb`,
    );
    expect(known.status).toBe(200);
  });
});
