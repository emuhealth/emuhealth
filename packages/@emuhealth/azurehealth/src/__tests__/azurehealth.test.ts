import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { microsoftPlugin, seedFromConfig as seedMicrosoft } from "@emulators/microsoft";
import { azurehealthPlugin, seedFromConfig, type AzureHealthSeedConfig } from "../index.js";

const origin = "http://localhost:4116";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function startService(config?: AzureHealthSeedConfig) {
  const app = new Hono();
  const store = new Store();
  azurehealthPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  azurehealthPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  return (path: string, token?: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as object) },
    });
}

/** The upstream Microsoft (Entra ID) emulator over HTTP, so the FHIR service can fetch its JWKS. */
async function entra(): Promise<string> {
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = new Hono();
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  microsoftPlugin.register(app as never, store, new WebhookDispatcher(), base, tokenMap);
  microsoftPlugin.seed?.(store, base);
  seedMicrosoft(store, base, {
    oauth_clients: [
      {
        client_id: "fhir-app",
        client_secret: "synthetic-secret",
        name: "FHIR app",
        redirect_uris: ["http://localhost:3000/cb"],
      },
    ],
  });
  holder.app = app;
  return base;
}

async function tokenFor(entraBase: string, scope: string): Promise<string> {
  const res = await fetch(`${entraBase}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "fhir-app",
      client_secret: "synthetic-secret",
      scope,
    }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe("Azure Health Data Services FHIR service", () => {
  it("serves FHIR at /{workspace}-{service} behind a Bearer token, with public metadata", async () => {
    const call = startService();
    expect((await call("/synthetic-fhir/metadata")).status).toBe(200);
    const anonymous = await call("/synthetic-fhir/Patient");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain('resource_id="http://localhost:4116/synthetic-fhir"');
    const patient = await call("/synthetic-fhir/Patient/syn-patient-001", "any-token");
    expect(patient.status).toBe(200);
    expect(patient.headers.get("x-ms-request-id")).toBeTruthy();
    expect((await call("/nope-fhir/Patient", "t")).status).toBe(404);
  });

  it("verifies Entra ID tokens from the Microsoft emulator", async () => {
    const entraBase = await entra();
    const discovery = (await (await fetch(`${entraBase}/.well-known/openid-configuration`)).json()) as {
      issuer: string;
    };
    const issuer = discovery.issuer;
    const call = startService({ entra: { issuer } });
    const good = await tokenFor(entraBase, "http://localhost:4116/synthetic-fhir/.default");
    expect((await call("/synthetic-fhir/Patient/syn-patient-001", good)).status).toBe(200);
    const otherResource = await tokenFor(entraBase, "http://localhost:4116/other-fhir/.default");
    const wrongAudience = await call("/synthetic-fhir/Patient/syn-patient-001", otherResource);
    expect(wrongAudience.status).toBe(401);
    expect((await call("/synthetic-fhir/Patient/syn-patient-001", "not-a-jwt")).status).toBe(401);
  });

  it("takes configured workspaces", async () => {
    const call = startService({
      workspaces: [{ name: "research", fhirServices: [{ name: "fhirone", preload: false }] }],
    });
    expect((await call("/synthetic-fhir/Patient", "t")).status).toBe(404);
    const created = await call("/research-fhirone/Patient", "t", {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Patient" }),
    });
    expect(created.status).toBe(201);
    expect(() => startService({ workspaces: [{ name: "Bad_Name" }] })).toThrow("lowercase");
  });
});
