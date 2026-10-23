import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { seedFromConfig, terraPlugin, terraSignature, type TerraSeedConfig } from "../index.js";

const origin = "http://localhost:4123";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function receiver() {
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/terra`, received };
}

function startService(config?: TerraSeedConfig) {
  const app = new Hono();
  const store = new Store();
  terraPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  terraPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { "dev-id": "synthetic-dev", "x-api-key": "synthetic-key" },
  ) => {
    const res = await app.request(`${origin}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as any) : await res.text(),
    };
  };
  /** Walk the widget: open it, pick the provider, pick a synthetic account. */
  const connect = async (provider: string, reference = "my-user-1") => {
    const session = await call("POST", "/v2/auth/generateWidgetSession", {
      reference_id: reference,
      providers: "FITBIT,DEXCOM",
      auth_success_redirect_url: "http://localhost:3000/connected",
    });
    const id = session.body.session_id;
    const picker = await app.request(`${origin}/widget/${id}?provider=${provider}`);
    expect(await picker.text()).toContain(`Sign in to ${provider}`);
    const done = await app.request(`${origin}/widget/${id}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ provider, person: "2" }).toString(),
    });
    return new URL(done.headers.get("Location")!);
  };
  return { app, call, connect };
}

describe("Terra API", () => {
  it("requires dev-id and x-api-key", async () => {
    const { call } = startService({ credentials: [{ devId: "d", apiKey: "k" }] });
    expect((await call("GET", "/v2/subscriptions")).status).toBe(401);
    expect((await call("GET", "/v2/subscriptions", undefined, { "dev-id": "d", "x-api-key": "k" })).status).toBe(200);
  });

  it("connects users through the widget and sends a signed auth webhook", async () => {
    const hook = await receiver();
    const { call, connect } = startService({ webhook: { url: hook.url, secret: "synthetic-signing-secret" } });
    const redirect = await connect("FITBIT");
    expect(redirect.searchParams.get("resource")).toBe("FITBIT");
    expect(redirect.searchParams.get("reference_id")).toBe("my-user-1");
    const userId = redirect.searchParams.get("user_id")!;
    const info = await call("GET", `/v2/userInfo?user_id=${userId}`);
    expect(info.body).toMatchObject({ status: "success", is_authenticated: true, user: { provider: "FITBIT" } });
    expect(hook.received).toHaveLength(1);
    const { headers, body } = hook.received[0];
    expect(JSON.parse(body)).toMatchObject({ type: "auth", status: "success", reference_id: "my-user-1" });
    const t = Number(String(headers["terra-signature"]).match(/t=(\d+)/)![1]);
    expect(headers["terra-signature"]).toBe(terraSignature("synthetic-signing-secret", t, body));
  });

  it("returns normalized data inline or sends it to the webhook", async () => {
    const hook = await receiver();
    const { call, connect } = startService({ webhook: { url: hook.url } });
    const userId = (await connect("DEXCOM")).searchParams.get("user_id")!;
    const daily = await call(
      "GET",
      `/v2/daily?user_id=${userId}&start_date=2025-03-01&end_date=2025-03-03&to_webhook=false`,
    );
    expect(daily.body.data).toHaveLength(3);
    expect(daily.body.data[0].distance_data.steps).toBeGreaterThan(1000);
    const sleep = await call("GET", `/v2/sleep?user_id=${userId}&start_date=2025-03-03&to_webhook=false`);
    expect(sleep.body.data[0].sleep_durations_data.asleep.duration_deep_sleep_state_seconds).toBeGreaterThan(0);
    const body = await call("GET", `/v2/body?user_id=${userId}&start_date=2025-03-03&to_webhook=false`);
    expect(body.body.data[0].glucose_data.blood_glucose_samples).toHaveLength(288);
    const queued = await call("GET", `/v2/activity?user_id=${userId}&start_date=2025-03-03`);
    expect(queued.body.message).toContain("webhook");
    expect(JSON.parse(hook.received.at(-1)!.body).type).toBe("activity");
    expect((await call("GET", `/v2/daily?user_id=${userId}`)).status).toBe(400);
  });

  it("deauthenticates users", async () => {
    const { call, connect } = startService();
    const userId = (await connect("FITBIT")).searchParams.get("user_id")!;
    expect((await call("GET", "/v2/subscriptions")).body.users).toHaveLength(1);
    expect((await call("DELETE", `/v2/auth/deauthenticateUser?user_id=${userId}`)).body.status).toBe("success");
    expect((await call("GET", "/v2/subscriptions")).body.users).toHaveLength(0);
    expect((await call("GET", `/v2/daily?user_id=${userId}&start_date=2025-03-03&to_webhook=false`)).status).toBe(404);
  });
});
