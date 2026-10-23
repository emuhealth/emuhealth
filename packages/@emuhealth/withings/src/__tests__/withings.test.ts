import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { MEASURE_TYPES, seedFromConfig, withingsPlugin, type WithingsSeedConfig } from "../index.js";

const origin = "http://localhost:4122";

async function startService(config?: WithingsSeedConfig, scope = "user.info,user.metrics,user.activity") {
  const app = new Hono();
  const store = new Store();
  withingsPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  withingsPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const page = await (
    await app.request(
      `${origin}/oauth2_user/authorize2?${new URLSearchParams({ client_id: "app", redirect_uri: "http://localhost:3000/cb", response_type: "code", scope, state: "s" })}`,
    )
  ).text();
  const request = page.match(/name="request" value="([^"]*)"/)![1];
  const consent = await app.request(`${origin}/oauth2_user/authorize2/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, user: "1" }).toString(),
  });
  const code = new URL(consent.headers.get("Location")!).searchParams.get("code")!;
  const token = (await (
    await app.request(`${origin}/v2/oauth2`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "requesttoken",
        grant_type: "authorization_code",
        code,
        client_id: "app",
        client_secret: "s",
        redirect_uri: "http://localhost:3000/cb",
      }).toString(),
    })
  ).json()) as { status: number; body: { access_token: string; userid: string; scope: string } };
  const call = async (path: string, form: Record<string, string>, auth = token.body.access_token) => {
    const res = await app.request(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${auth}` },
      body: new URLSearchParams(form).toString(),
    });
    return { http: res.status, body: (await res.json()) as any };
  };
  return { app, token, call };
}

describe("Withings API", () => {
  it("returns tokens inside status 0 bodies and errors as HTTP 200 with a status", async () => {
    const { token, call } = await startService();
    expect(token.status).toBe(0);
    expect(token.body).toMatchObject({ userid: "5000001", scope: "user.info,user.metrics,user.activity" });
    const bad = await call("/measure", { action: "getmeas" }, "nope");
    expect(bad.http).toBe(200);
    expect(bad.body.status).toBe(401);
    expect((await call("/measure", { action: "nope" })).body.status).toBe(503);
  });

  it("returns measure groups with scaled values", async () => {
    const { call } = await startService();
    const start = String(Date.parse("2025-03-04T00:00:00Z") / 1000);
    const end = String(Date.parse("2025-03-05T00:00:00Z") / 1000);
    const all = await call("/measure", { action: "getmeas", startdate: start, enddate: end });
    expect(all.body.body.measuregrps).toHaveLength(2);
    const weight = await call("/measure", {
      action: "getmeas",
      meastype: String(MEASURE_TYPES.weight),
      startdate: start,
      enddate: end,
    });
    const m = weight.body.body.measuregrps[0].measures[0];
    expect(m).toMatchObject({ type: 1, unit: -3 });
    expect(m.value * 10 ** m.unit).toBeGreaterThan(30);
    const bp = await call("/measure", { action: "getmeas", meastypes: "9,10", startdate: start, enddate: end });
    expect(bp.body.body.measuregrps[0].measures.map((x: { type: number }) => x.type)).toEqual([9, 10]);
  });

  it("returns activity, sleep summaries, and devices", async () => {
    const { call } = await startService();
    const activity = await call("/v2/measure", {
      action: "getactivity",
      startdateymd: "2025-03-01",
      enddateymd: "2025-03-04",
    });
    expect(activity.body.body.activities).toHaveLength(4);
    expect(activity.body.body.activities[0].steps).toBeGreaterThan(1000);
    const sleep = await call("/v2/sleep", {
      action: "getsummary",
      startdateymd: "2025-03-04",
      enddateymd: "2025-03-04",
    });
    expect(sleep.body.body.series[0].data.sleep_score).toBeGreaterThan(50);
    expect(
      (await call("/v2/user", { action: "getdevice" })).body.body.devices.map((d: { model: string }) => d.model),
    ).toEqual(["Body+", "BPM Connect"]);
    expect((await call("/v2/measure", { action: "getactivity", startdateymd: "bad" })).body.status).toBe(503);
  });

  it("requires scopes", async () => {
    const { call } = await startService(undefined, "user.info");
    expect((await call("/measure", { action: "getmeas" })).body.status).toBe(401);
    expect((await call("/v2/user", { action: "getdevice" })).body.status).toBe(0);
  });

  it("notifies subscribed callback URLs", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(body);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { app, call } = await startService();
      const callbackurl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/withings`;
      expect((await call("/notify", { action: "subscribe", callbackurl, appli: "1" })).body.status).toBe(0);
      expect((await call("/notify", { action: "list" })).body.body.profiles).toHaveLength(1);
      await app.request(`${origin}/emulator/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "userid=5000001&appli=1",
      });
      expect(received).toHaveLength(1);
      expect(new URLSearchParams(received[0]).get("userid")).toBe("5000001");
      expect((await call("/notify", { action: "revoke", callbackurl, appli: "1" })).body.status).toBe(0);
      expect((await call("/notify", { action: "revoke", callbackurl, appli: "1" })).body.status).toBe(294);
    } finally {
      server.close();
    }
  });
});
