import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { availityPlugin, seedFromConfig, type AvailitySeedConfig } from "../index.js";

const origin = "http://localhost:4118";

async function startService(config?: AvailitySeedConfig) {
  const app = new Hono();
  const store = new Store();
  availityPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  availityPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const tokenRes = await app.request(`${origin}/availity/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=synthetic&client_secret=synthetic&scope=hipaa",
  });
  const token = ((await tokenRes.json()) as { access_token: string }).access_token;
  return async (method: string, path: string, body?: string | object, headers: Record<string, string> = {}) => {
    const res = await app.request(`${origin}/availity${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(typeof body === "string"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : body
            ? { "Content-Type": "application/json" }
            : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
  };
}

describe("Availity", () => {
  it("lists payers and requires a token", async () => {
    const call = await startService();
    const payers = await call("GET", "/availity-payer-list?transactionType=278");
    expect(payers.body.payers.map((p: { payerId: string }) => p.payerId)).toEqual(["SYNAV1"]);
    const app = new Hono();
    const store = new Store();
    availityPlugin.register(app as never, store, new WebhookDispatcher(), origin);
    expect((await app.request(`${origin}/availity/v1/coverages/x`)).status).toBe(401);
  });

  it("runs coverages asynchronously until statusCode 4", async () => {
    const call = await startService();
    const started = await call(
      "POST",
      "/v1/coverages",
      "payerId=SYNAV1&providerNpi=0000000016&memberId=AVM0000001&serviceType=30",
    );
    expect(started.status).toBe(202);
    expect(started.body.statusCode).toBe("0");
    const first = await call("GET", `/v1/coverages/${started.body.id}`);
    expect(first.body).toMatchObject({ statusCode: "0", status: "In Progress" });
    const done = await call("GET", `/v1/coverages/${started.body.id}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ statusCode: "4", status: "Complete", subscriber: { memberId: "AVM0000001" } });
    expect(done.body.plans[0].benefits.map((b: { name: string }) => b.name)).toContain("Deductible");
    const invalid = await call("POST", "/v1/coverages", "payerId=SYNAV1");
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e: { field: string }) => e.field)).toEqual(["providerNpi", "memberId"]);
    const unknown = await call("POST", "/v1/coverages", "payerId=SYNAV1&providerNpi=0000000016&memberId=NOPE");
    await call("GET", `/v1/coverages/${unknown.body.id}`);
    expect((await call("GET", `/v1/coverages/${unknown.body.id}`)).body.statusCode).toBe("6");
  });

  it("answers claim status inquiries from the synthetic claim history", async () => {
    const call = await startService({ pollsUntilComplete: 0 });
    const started = await call("GET", "/v1/claim-statuses?payerId=SYNAV1&providerNpi=0000000016&memberId=AVM0000001");
    const id = started.body.claimStatuses[0].id;
    const done = await call("GET", `/v1/claim-statuses/${id}`);
    expect(done.body.statusCode).toBe("4");
    expect(done.body.claimStatuses[0].statusDetails[0].categoryCode).toBe("F1");
  });

  it("creates, reads, and voids service reviews", async () => {
    const call = await startService({ pollsUntilComplete: 0 });
    const created = await call("POST", "/v2/service-reviews", {
      payer: { id: "SYNAV1" },
      requestTypeCode: "HS",
      serviceTypeCode: "1",
    });
    expect(created.status).toBe(202);
    const location = created.headers.get("Location")!.replace("/availity", "");
    const review = await call("GET", location);
    expect(review.body).toMatchObject({ status: "Approved", statusCode: "A1", updatable: true });
    await call("DELETE", location);
    expect((await call("GET", location)).body.status).toBe("Voided");
    expect((await call("POST", "/v2/service-reviews", { payer: { id: "SYNAV2" } })).status).toBe(400);
  });

  it("returns Demo plan mock scenarios", async () => {
    const call = await startService();
    const inProgress = await call("POST", "/v1/coverages", {}, { "X-Api-Mock-Scenario-ID": "Coverages-InProgress-i" });
    expect(inProgress.status).toBe(202);
    expect(inProgress.headers.get("X-Api-Mock-Response")).toBe("true");
    expect(
      (await call("GET", "/v2/service-reviews/x", undefined, { "X-Api-Mock-Scenario-ID": "SR-GetPayerDown-i" })).status,
    ).toBe(504);
    expect((await call("GET", "/v1/coverages/x", undefined, { "X-Api-Mock-Scenario-ID": "Nope" })).status).toBe(400);
  });
});
