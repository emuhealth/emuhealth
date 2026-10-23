import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { CERNER_TENANT, cernerPlugin, seedFromConfig, type CernerSeedConfig } from "../index.js";

const origin = "http://localhost:4109";
const base = `${origin}/r4/${CERNER_TENANT}`;
const oauth = `${origin}/tenants/${CERNER_TENANT}/protocols/oauth2/profiles/smart-v1`;
const redirect = "http://localhost:3000/callback";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function startService(config?: CernerSeedConfig) {
  const app = new Hono();
  const store = new Store();
  cernerPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  cernerPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path.startsWith("http") ? path : `${base}${path}`, init) as Promise<JsonResponse>;
  return { app, request };
}

describe("Oracle Health (Cerner) URL shape", () => {
  it("serves FHIR under the tenant path with OAuth on the tenant's authorization paths", async () => {
    const { request } = startService();
    expect((await request("/Patient/syn-patient-001")).status).toBe(200);
    expect((await (await request("/metadata")).json()).software.name).toBe("emuhealth Oracle Health emulator");
    const smart = await (await request("/.well-known/smart-configuration")).json();
    expect(smart).toMatchObject({
      issuer: base,
      authorization_endpoint: `${oauth}/personas/provider/authorize`,
      token_endpoint: `${oauth}/token`,
    });
    expect((await request(`${origin}/r4/another-tenant/Patient/syn-patient-001`)).status).toBe(404);
  });

  it("requires Millennium's search parameters", async () => {
    const { request } = startService();
    const bare = await request("/Observation");
    expect(bare.status).toBe(400);
    expect((await bare.json()).issue[0].diagnostics).toContain("patient, subject, _id");
    expect((await request("/Observation?patient=syn-patient-001")).status).toBe(200);
    expect((await request("/Patient?family:exact=Cohen")).status).toBe(200);
    expect((await request("/Practitioner")).status).toBe(200);
  });

  it("redirects the patient persona to the authorize flow and adds tenant to tokens", async () => {
    const { app } = startService({ smart: { requirePkce: false } });
    const persona = await app.request(`${oauth}/personas/patient/authorize?client_id=a&response_type=code`);
    expect(persona.status).toBe(307);
    expect(persona.headers.get("Location")).toBe(
      `/tenants/${CERNER_TENANT}/protocols/oauth2/profiles/smart-v1/personas/provider/authorize?client_id=a&response_type=code`,
    );

    const launch = await app.request(
      `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}&patient=syn-patient-002&practitioner=syn-practitioner-1`,
    );
    const launchId = new URL(launch.headers.get("Location")!).searchParams.get("launch")!;
    const auth = await app.request(
      `${oauth}/personas/provider/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "app",
        redirect_uri: redirect,
        aud: base,
        launch: launchId,
        scope: "launch openid fhirUser user/Patient.read",
      })}`,
    );
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
    const token = await (
      (await app.request(`${oauth}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: "app" }),
      })) as JsonResponse
    ).json();
    expect(token).toMatchObject({ tenant: CERNER_TENANT, username: "syn-practitioner-1", patient: "syn-patient-002" });
  });

  it("lets system accounts use client_credentials with a client secret", async () => {
    const { app, request } = startService({
      smart: {
        clients: [{ client_id: "system-account", client_secret: "synthetic-secret", scope: "system/Patient.read" }],
      },
    });
    const basic = `Basic ${Buffer.from("system-account:synthetic-secret").toString("base64")}`;
    const res = (await app.request(`${oauth}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/Patient.read" }),
    })) as JsonResponse;
    expect(res.status).toBe(200);
    const token = await res.json();
    expect(token.scope).toBe("system/Patient.read");
    const patient = await request("/Patient/syn-patient-001", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(patient.status).toBe(200);
    const wrong = await app.request(`${oauth}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from("system-account:wrong").toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/Patient.read" }),
    });
    expect(wrong.status).toBe(401);
  });
});
