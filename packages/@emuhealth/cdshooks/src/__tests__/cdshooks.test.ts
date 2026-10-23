import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { cdshooksPlugin, seedFromConfig, validateCards, type CdsHooksSeedConfig } from "../index.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Serve a Hono app over real HTTP, since the simulated EHR calls CDS services with fetch. */
async function serve(build: (origin: string) => Hono): Promise<{ origin: string; app: Hono }> {
  // The app needs the server's origin, so it is built after listening and read through this holder.
  const holder: { app?: Hono } = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await holder.app!.request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  holder.app = build(origin);
  return { origin, app: holder.app };
}

function emulator(config?: CdsHooksSeedConfig) {
  return serve((origin) => {
    const app = new Hono();
    const store = new Store();
    cdshooksPlugin.register(app as never, store, new WebhookDispatcher(), origin);
    cdshooksPlugin.seed?.(store, origin);
    if (config) seedFromConfig(store, origin, config);
    return app;
  });
}

const post = (origin: string, path: string, body: unknown) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("simulated EHR", () => {
  it("fires patient-view with prefetch and gets a valid card from the sample service", async () => {
    const { origin } = await emulator();
    const res = await post(origin, "/ehr/fire", {
      discoveryUrl: `${origin}/cds-services`,
      hook: "patient-view",
      patientId: "syn-patient-002",
    });
    const invocation = (await res.json()) as any;
    expect(invocation.status).toBe(200);
    expect(invocation.issues).toEqual([]);
    expect(invocation.request.prefetch.patient.id).toBe("syn-patient-002");
    expect(invocation.request.context).toMatchObject({
      patientId: "syn-patient-002",
      userId: expect.stringMatching(/^Practitioner\//),
    });
    expect(invocation.response.cards[0].summary).toContain("Synthetic patient");
    const log = (await (await fetch(`${origin}/ehr/invocations`)).json()) as any;
    expect(log.invocations).toHaveLength(1);
  });

  it("signs requests with a JWT the service can verify against the EHR's JWKS", async () => {
    const { origin: ehr } = await emulator();
    let authorization = "";
    const { origin: service } = await serve(() => {
      const app = new Hono();
      app.get("/cds-services", (c) =>
        c.json({ services: [{ hook: "patient-view", id: "echo", description: "Echo", title: "Echo" }] }),
      );
      app.post("/cds-services/echo", (c) => {
        authorization = c.req.header("Authorization") ?? "";
        return c.json({ cards: [{ summary: "x".repeat(200), indicator: "loud", source: {} }] });
      });
      return app;
    });
    const invocation = (await (
      await post(ehr, "/ehr/fire", { discoveryUrl: `${service}/cds-services`, hook: "patient-view" })
    ).json()) as any;
    const jwt = authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(jwt, createRemoteJWKSet(new URL(`${ehr}/.well-known/jwks.json`)), {
      issuer: ehr,
      audience: `${service}/cds-services/echo`,
    });
    expect(payload.jti).toBeDefined();
    expect(invocation.issues).toEqual([
      "cards[0].summary must be 140 characters or fewer",
      "cards[0].indicator must be info, warning, or critical",
      "cards[0].source.label is required",
    ]);
  });

  it("fires order-sign with draft orders and the sample allergy check warns", async () => {
    const { origin } = await emulator({
      generate: false,
      resources: [
        { resourceType: "Practitioner", id: "dr1" },
        { resourceType: "Patient", id: "p1", name: [{ family: "Example", given: ["Jamie"] }] },
        {
          resourceType: "AllergyIntolerance",
          id: "a1",
          code: { text: "Penicillin" },
          patient: { reference: "Patient/p1" },
        },
      ],
    });
    const invocation = (await (
      await post(origin, "/ehr/fire", {
        discoveryUrl: `${origin}/cds-services`,
        hook: "order-sign",
        patientId: "p1",
        medication: "amoxicillin 500 MG Oral Capsule",
      })
    ).json()) as any;
    expect(invocation.request.context.draftOrders.entry[0].resource.resourceType).toBe("MedicationRequest");
    expect(invocation.response.cards[0]).toMatchObject({ indicator: "warning" });
    expect(invocation.response.cards[0].suggestions[0].actions[0].type).toBe("delete");
    expect(invocation.issues).toEqual([]);
  });

  it("serves an inspector form that fires hooks", async () => {
    const { origin } = await emulator();
    const page = await (await fetch(`${origin}/_inspector`)).text();
    expect(page).toContain('class="inspector-field"');
    const fired = await fetch(`${origin}/_inspector/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        discoveryUrl: `${origin}/cds-services`,
        hook: "patient-view",
        patientId: "syn-patient-001",
      }),
    });
    expect(await fired.text()).toContain("The response follows the CDS Hooks card rules");
  });
});

describe("validateCards", () => {
  it("accepts valid responses and explains invalid ones", () => {
    expect(validateCards({ cards: [] })).toEqual([]);
    expect(validateCards({})).toEqual(["The response must be a JSON object with a cards array"]);
    expect(
      validateCards({
        cards: [
          { summary: "s", indicator: "info", source: { label: "l" }, links: [{ label: "x", url: "y", type: "other" }] },
        ],
      }),
    ).toEqual(["cards[0].links[0].type must be absolute or smart"]);
  });
});
