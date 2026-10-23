import { describe, it, expect } from "vitest";
import { Hono, Store } from "@emulators/core";
import { dailyMetrics, daysBetween, deviceUsers, glucoseSeries, heartRateSeries, registerOAuth } from "../index.js";

describe("synthetic device data", () => {
  it("derives users from the patient generator and is deterministic", () => {
    const users = deviceUsers();
    expect(users).toHaveLength(5);
    expect(users[0]).toMatchObject({ id: "1", patientId: "syn-patient-001" });
    expect(dailyMetrics(users[0], "2025-03-04")).toEqual(dailyMetrics(users[0], "2025-03-04"));
    expect(dailyMetrics(users[0], "2025-03-04")).not.toEqual(dailyMetrics(users[1], "2025-03-04"));
    const day = dailyMetrics(users[0], "2025-03-04");
    expect(day.sleep.deepMinutes + day.sleep.lightMinutes + day.sleep.remMinutes).toBeGreaterThan(250);
    expect(daysBetween("2025-01-30", "2025-02-02")).toEqual(["2025-01-30", "2025-01-31", "2025-02-01", "2025-02-02"]);
  });

  it("generates 5 minute glucose with meal peaks and heart rate series", () => {
    const user = deviceUsers()[0];
    const start = Date.parse("2025-03-04T00:00:00Z");
    const series = glucoseSeries(user, start, start + 86_400_000 - 1);
    expect(series).toHaveLength(288);
    const at = (h: number) => series[h * 12].value;
    expect(at(9)).toBeGreaterThan(at(4));
    for (const r of series) expect(r.value).toBeGreaterThan(60);
    expect(heartRateSeries(user, start, start + 3_600_000, 15)).toHaveLength(5);
  });
});

describe("OAuth authorization code flow", () => {
  it("shows a consent page, issues a code, and exchanges and refreshes tokens", async () => {
    const app = new Hono();
    const store = new Store();
    const users = deviceUsers();
    const oauth = registerOAuth(app as never, store, {
      key: "test",
      label: "Test",
      authorizePath: "/oauth/authorize",
      defaultScope: "read",
      accessTtl: 60,
      users: () => users,
    });
    app.get("/me", (c) => {
      const auth = oauth.authenticate(c as never);
      return auth ? c.json({ id: auth.user.id }) : c.json({ error: "unauthorized" }, 401);
    });
    const page = await app.request(
      "http://x/oauth/authorize?client_id=app&redirect_uri=http://localhost:3000/cb&response_type=code&state=s",
    );
    const html = await page.text();
    expect(html).toContain("Sign in to Test");
    const request = html.match(/name="request" value="([^"]*)"/)![1];
    const consent = await app.request("http://x/oauth/authorize/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, user: "2" }).toString(),
    });
    const location = new URL(consent.headers.get("Location")!);
    expect(location.searchParams.get("state")).toBe("s");
    const result = oauth.exchange({
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      client_id: "app",
      redirect_uri: "http://localhost:3000/cb",
    });
    if ("error" in result) throw new Error(result.description);
    const me = await app.request("http://x/me", { headers: { Authorization: `Bearer ${result.access.token}` } });
    expect(await me.json()).toEqual({ id: "2" });
    const refreshed = oauth.exchange({
      grant_type: "refresh_token",
      refresh_token: result.refresh.token,
      client_id: "app",
    });
    expect("access" in refreshed).toBe(true);
    expect(
      oauth.exchange({ grant_type: "refresh_token", refresh_token: result.refresh.token, client_id: "app" }),
    ).toMatchObject({ error: "invalid_grant" });
    oauth.setClients([{ client_id: "registered", client_secret: "s", redirect_uris: ["http://localhost:3000/cb"] }]);
    expect(
      (await app.request("http://x/oauth/authorize?client_id=app&redirect_uri=http://localhost:3000/cb")).status,
    ).toBe(400);
  });
});
