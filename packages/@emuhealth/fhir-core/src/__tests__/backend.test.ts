import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, type FhirResource, type FhirSeedConfig } from "../index.js";

const base = "http://localhost:4100";
const tokenUrl = `${base}/auth/token`;
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

// Synthetic records only.
const resources: FhirResource[] = [
  { resourceType: "Patient", id: "p1" },
  { resourceType: "Patient", id: "p2" },
];

async function keys(alg: "RS384" | "ES384", kid: string) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { privateKey, jwk, alg, kid };
}

function assertion(
  key: { privateKey: PrivateKey; alg: string; kid: string },
  claims: { iss?: string; sub?: string; aud?: string; exp?: string | number; jti?: string } = {},
) {
  const iss = claims.iss ?? "backend";
  return new SignJWT({})
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
    .setIssuer(iss)
    .setSubject(claims.sub ?? iss)
    .setAudience(claims.aud ?? tokenUrl)
    .setExpirationTime(claims.exp ?? "4m")
    .setJti(claims.jti ?? randomUUID())
    .sign(key.privateKey);
}

function createApp(smart: FhirSeedConfig["smart"]) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { generate: false, resources, smart });
  return app;
}

function token(app: Hono, params: Record<string, string>): Promise<JsonResponse> {
  return app.request(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

const backendGrant = (signed: string, scope = "system/*.rs") => ({
  grant_type: "client_credentials",
  scope,
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  client_assertion: signed,
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("SMART Backend Services", () => {
  it("issues a short-lived system token for a valid RS384 assertion and enforces it", async () => {
    const key = await keys("RS384", "k1");
    const app = createApp({ clients: [{ client_id: "backend", jwks: { keys: [key.jwk] } }] });
    const res = await token(app, backendGrant(await assertion(key), "system/*.rs patient/*.rs openid"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 300, scope: "system/*.rs" });
    expect(body.refresh_token).toBeUndefined();

    const auth = { Authorization: `Bearer ${body.access_token}` };
    const patients = await ((await app.request(`${base}/Patient`, { headers: auth })) as JsonResponse).json();
    expect(patients.total).toBe(2);
    const write = await app.request(`${base}/Patient`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Patient" }),
    });
    expect(write.status).toBe(403);
  });

  it("accepts ES384 keys and limits scopes to the client's registration", async () => {
    const key = await keys("ES384", "ec1");
    const app = createApp({
      clients: [{ client_id: "backend", jwks: { keys: [key.jwk] }, scope: "system/Patient.rs" }],
    });
    const body = await (
      await token(app, backendGrant(await assertion(key), "system/Patient.rs system/Observation.rs"))
    ).json();
    expect(body.scope).toBe("system/Patient.rs");
    const none = await (await token(app, backendGrant(await assertion(key), "system/Observation.rs"))).json();
    expect(none.error).toBe("invalid_scope");
  });

  it("rejects replayed, expired, misaddressed, wrongly signed, and unknown assertions", async () => {
    const key = await keys("RS384", "k1");
    const other = await keys("RS384", "k1");
    const app = createApp({ clients: [{ client_id: "backend", jwks: { keys: [key.jwk] } }] });
    const expectInvalid = async (signed: string) => {
      const res = await token(app, backendGrant(signed));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid_client");
    };
    const once = await assertion(key, { jti: "fixed" });
    expect((await token(app, backendGrant(once))).status).toBe(200);
    await expectInvalid(once);
    await expectInvalid(await assertion(key, { exp: Math.floor(Date.now() / 1000) - 10 }));
    await expectInvalid(await assertion(key, { exp: "1h" }));
    await expectInvalid(await assertion(key, { aud: `${base}/other` }));
    await expectInvalid(await assertion(key, { sub: "someone-else" }));
    await expectInvalid(await assertion(other));
    await expectInvalid(await assertion(key, { iss: "unknown" }));
    await expectInvalid("not-a-jwt");
    const rs256 = await generateKeyPair("RS256");
    await expectInvalid(
      await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("backend")
        .setSubject("backend")
        .setAudience(tokenUrl)
        .setExpirationTime("4m")
        .setJti(randomUUID())
        .sign(rs256.privateKey),
    );
  });

  it("requires private_key_jwt for client_credentials and for clients registered with keys", async () => {
    const key = await keys("RS384", "k1");
    const app = createApp({
      clients: [
        { client_id: "backend", jwks: { keys: [key.jwk] } },
        { client_id: "secret-app", client_secret: "s3cret", redirect_uris: ["http://localhost:3000/cb"] },
      ],
    });
    const secret = await token(app, {
      grant_type: "client_credentials",
      scope: "system/*.rs",
      client_id: "secret-app",
      client_secret: "s3cret",
    });
    expect(secret.status).toBe(401);
    const noAssertion = await token(app, {
      grant_type: "client_credentials",
      scope: "system/*.rs",
      client_id: "backend",
    });
    expect((await noAssertion.json()).error_description).toContain("private_key_jwt");
    const wrongType = await token(app, { ...backendGrant(await assertion(key)), client_assertion_type: "something" });
    expect(wrongType.status).toBe(401);
  });

  it("lets apps with registered keys use private_key_jwt for the authorization code flow", async () => {
    const key = await keys("RS384", "k1");
    const redirect = "http://localhost:3000/cb";
    const app = createApp({
      clients: [{ client_id: "backend", jwks: { keys: [key.jwk] }, redirect_uris: [redirect] }],
    });
    // Confidential clients do not need PKCE.
    const auth = await app.request(
      `${base}/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "backend", redirect_uri: redirect, aud: base, scope: "patient/*.rs" })}`,
    );
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
    const exchange = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertion(key),
    };
    expect((await token(app, exchange)).status).toBe(200);
  });

  it("fetches keys from a jwks_uri", async () => {
    const key = await keys("RS384", "remote");
    server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [key.jwk] }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const app = createApp({ clients: [{ client_id: "backend", jwks_uri: `http://127.0.0.1:${port}/jwks.json` }] });
    expect((await token(app, backendGrant(await assertion(key)))).status).toBe(200);
  });

  it("advertises Backend Services in discovery and validates client config", async () => {
    const key = await keys("RS384", "k1");
    const app = createApp({ clients: [{ client_id: "backend", jwks: { keys: [key.jwk] } }] });
    const config = await ((await app.request(`${base}/.well-known/smart-configuration`)) as JsonResponse).json();
    expect(config.grant_types_supported).toContain("client_credentials");
    expect(config.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
    expect(config.token_endpoint_auth_signing_alg_values_supported).toEqual(["RS384", "ES384"]);
    expect(config.capabilities).toContain("client-confidential-asymmetric");
    expect(() => createApp({ clients: [{ client_id: "x" }] })).toThrow("redirect_uris");
    expect(() => createApp({ clients: [{ client_id: "x", jwks: {} as never }] })).toThrow("keys array");
    expect(() => createApp({ clients: [{ client_id: "x", jwks_uri: "file:///keys" }] })).toThrow("jwks_uri");
  });
});
