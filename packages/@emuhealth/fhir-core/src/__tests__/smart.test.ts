import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, registerFhirRoutes, seedFromConfig, type FhirSeedConfig, type FhirResource } from "../index.js";

const base = "http://localhost:4100";
const app_redirect = "http://localhost:3000/callback";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

// Synthetic records only.
const resources: FhirResource[] = [
  { resourceType: "Practitioner", id: "dr1", name: [{ family: "Example", given: ["Riley"], prefix: ["Dr."] }] },
  {
    resourceType: "Patient",
    id: "p1",
    identifier: [{ system: "urn:emuhealth:synthetic:mrn", value: "SYN-000001" }],
    name: [{ family: "Example", given: ["Jamie"] }],
    gender: "female",
    birthDate: "1980-01-01",
  },
  {
    resourceType: "Encounter",
    id: "e1",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  },
];

function createApp(smart?: FhirSeedConfig["smart"]) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { generate: false, resources, ...(smart ? { smart } : {}) });
  return app;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(params: Record<string, string>): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "demo-app",
    redirect_uri: app_redirect,
    aud: base,
    state: "xyz",
    ...params,
  });
  return `${base}/auth/authorize?${query}`;
}

const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];

/** Follow the pickers, choosing the first practitioner and patient, until the redirect back to the app. */
async function completeAuthorize(app: Hono, url: string): Promise<URL> {
  let res = await app.request(url);
  for (let step = 0; step < 3 && res.status === 200; step++) {
    const html = await res.text();
    const request = hidden(html, "request")!;
    const field = html.includes('name="practitioner"') ? "practitioner" : "patient";
    res = await app.request(`${base}/auth/authorize/select`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, [field]: hidden(html, field)! }).toString(),
    });
  }
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location")!);
}

function token(app: Hono, params: Record<string, string>, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return app.request(`${base}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

describe("SMART discovery", () => {
  it("publishes smart-configuration and a JWKS", async () => {
    const app = createApp();
    const res: JsonResponse = await app.request(`${base}/.well-known/smart-configuration`);
    expect(res.status).toBe(200);
    const config = await res.json();
    expect(config).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/auth/authorize`,
      token_endpoint: `${base}/auth/token`,
      introspection_endpoint: `${base}/auth/introspect`,
      revocation_endpoint: `${base}/auth/revoke`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(config.capabilities).toEqual(
      expect.arrayContaining([
        "launch-ehr",
        "launch-standalone",
        "client-public",
        "context-standalone-patient",
        "permission-v2",
      ]),
    );
    const jwks = await ((await app.request(`${base}/.well-known/jwks.json`)) as JsonResponse).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
  });
});

describe("SMART standalone launch", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("walks the practitioner and patient pickers and issues tokens with context", async () => {
    const { verifier, challenge } = pkce();
    const first = await app.request(
      authorizeUrl({
        scope: "launch/patient openid fhirUser patient/*.rs offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: "n-1",
      }),
    );
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("Sign in as a practitioner");
    expect(html).toContain("Dr. Riley Example");

    const callback = await completeAuthorize(
      app,
      authorizeUrl({
        scope: "launch/patient openid fhirUser patient/*.rs offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: "n-1",
      }),
    );
    expect(callback.origin + callback.pathname).toBe(app_redirect);
    expect(callback.searchParams.get("state")).toBe("xyz");

    const res = await token(app, {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: app_redirect,
      client_id: "demo-app",
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "launch/patient openid fhirUser patient/*.rs offline_access",
      patient: "p1",
      need_patient_banner: true,
    });
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    const jwks = createLocalJWKSet(await ((await app.request(`${base}/.well-known/jwks.json`)) as JsonResponse).json());
    const { payload } = await jwtVerify(body.id_token, jwks, { issuer: base, audience: "demo-app" });
    expect(payload).toMatchObject({ sub: "Practitioner/dr1", fhirUser: `${base}/Practitioner/dr1`, nonce: "n-1" });
  });

  it("issues a code right away when no context is needed, and shows patients in the picker", async () => {
    const { challenge } = pkce();
    const direct = await app.request(
      authorizeUrl({ scope: "patient/*.rs", code_challenge: challenge, code_challenge_method: "S256" }),
    );
    expect(direct.status).toBe(302);
    expect(new URL(direct.headers.get("Location")!).searchParams.get("code")).toBeTruthy();

    const picker = await app.request(
      authorizeUrl({ scope: "launch/patient patient/*.rs", code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const html = await picker.text();
    expect(html).toContain("Select a patient");
    expect(html).toContain("Jamie Example");
    expect(html).toContain("female, born 1980-01-01");
    expect(html).toContain("MRN SYN-000001");
  });

  it("supports POST to the authorize endpoint and form_post responses", async () => {
    const { challenge } = pkce();
    const res = await app.request(`${base}/auth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URL(
        authorizeUrl({
          scope: "patient/*.rs",
          code_challenge: challenge,
          code_challenge_method: "S256",
          response_mode: "form_post",
        }),
      ).searchParams.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="${app_redirect}"`);
    expect(hidden(html, "code")).toBeTruthy();
  });
});

describe("SMART EHR launch", () => {
  it("launches the app with iss and launch, then skips the pickers", async () => {
    const app = createApp();
    const launch = await app.request(
      `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}&patient=p1&encounter=e1&practitioner=dr1`,
    );
    expect(launch.status).toBe(302);
    const launchUrl = new URL(launch.headers.get("Location")!);
    expect(launchUrl.pathname).toBe("/launch");
    expect(launchUrl.searchParams.get("iss")).toBe(base);

    const { verifier, challenge } = pkce();
    const callback = await completeAuthorize(
      app,
      authorizeUrl({
        scope: "launch openid fhirUser patient/*.rs",
        launch: launchUrl.searchParams.get("launch")!,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    const body = await (
      await token(app, {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: app_redirect,
        client_id: "demo-app",
        code_verifier: verifier,
      })
    ).json();
    expect(body).toMatchObject({ patient: "p1", encounter: "e1", need_patient_banner: false });
    expect(body.id_token).toBeTruthy();
  });

  it("offers a patient picker when no patient is given, and explains itself without launch_uri", async () => {
    const app = createApp();
    const page = await app.request(
      `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}`,
    );
    const html = await page.text();
    expect(html).toContain("Launch app from the EHR");
    const chosen = await app.request(`${base}/auth/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        launch_uri: hidden(html, "launch_uri")!,
        patient: hidden(html, "patient")!,
      }).toString(),
    });
    expect(chosen.status).toBe(302);
    expect(new URL(chosen.headers.get("Location")!).searchParams.get("launch")).toBeTruthy();

    expect((await app.request(`${base}/auth/launch`)).status).toBe(400);
    expect((await app.request(`${base}/auth/launch?launch_uri=http://x/l&patient=nope`)).status).toBe(400);
  });

  it("rejects unknown launch values and launches without the launch scope", async () => {
    const app = createApp();
    const { challenge } = pkce();
    const bad = await app.request(
      authorizeUrl({
        scope: "launch patient/*.rs",
        launch: "nope",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(new URL(bad.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });
});

describe("SMART authorization errors and PKCE", () => {
  it("requires S256 PKCE for public clients unless requirePkce is false", async () => {
    const app = createApp();
    const missing = await app.request(authorizeUrl({ scope: "patient/*.rs" }));
    const err = new URL(missing.headers.get("Location")!);
    expect(err.searchParams.get("error")).toBe("invalid_request");
    expect(err.searchParams.get("state")).toBe("xyz");
    const plain = await app.request(
      authorizeUrl({ scope: "patient/*.rs", code_challenge: "abc", code_challenge_method: "plain" }),
    );
    expect(new URL(plain.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");

    const relaxed = createApp({ requirePkce: false });
    const ok = await relaxed.request(authorizeUrl({ scope: "patient/*.rs" }));
    expect(new URL(ok.headers.get("Location")!).searchParams.get("code")).toBeTruthy();
  });

  it("checks aud, response_type, the verifier, redirect_uri, client, and single use", async () => {
    const app = createApp();
    const { verifier, challenge } = pkce();
    const wrongAud = await app.request(
      authorizeUrl({
        scope: "patient/*.rs",
        aud: "http://other",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(new URL(wrongAud.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    const wrongType = await app.request(
      authorizeUrl({
        scope: "patient/*.rs",
        response_type: "token",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(new URL(wrongType.headers.get("Location")!).searchParams.get("error")).toBe("unsupported_response_type");

    const getCode = async () =>
      new URL(
        (
          await app.request(
            authorizeUrl({ scope: "patient/*.rs", code_challenge: challenge, code_challenge_method: "S256" }),
          )
        ).headers.get("Location")!,
      ).searchParams.get("code")!;
    const exchange = (code: string, extra: Record<string, string> = {}) =>
      token(app, {
        grant_type: "authorization_code",
        code,
        redirect_uri: app_redirect,
        client_id: "demo-app",
        code_verifier: verifier,
        ...extra,
      });

    expect((await (await exchange(await getCode(), { code_verifier: "wrong" })).json()).error).toBe("invalid_grant");
    expect(
      (await (await exchange(await getCode(), { redirect_uri: "http://localhost:3000/other" })).json()).error,
    ).toBe("invalid_grant");
    expect((await (await exchange(await getCode(), { client_id: "someone-else" })).json()).error).toBe("invalid_grant");
    const code = await getCode();
    expect((await exchange(code)).status).toBe(200);
    expect((await (await exchange(code)).json()).error).toBe("invalid_grant");
    expect((await (await token(app, { grant_type: "password" })).json()).error).toBe("unsupported_grant_type");
  });

  it("shows an error page instead of redirecting to an untrusted redirect_uri", async () => {
    const app = createApp();
    expect((await app.request(authorizeUrl({ redirect_uri: "not-a-url" }))).status).toBe(400);
  });
});

describe("SMART registered clients", () => {
  const smart = {
    clients: [
      { client_id: "public-app", redirect_uris: [app_redirect], scope: "launch/patient patient/*.rs offline_access" },
      { client_id: "server-app", client_secret: "s3cret", redirect_uris: [app_redirect] },
    ],
  };

  it("rejects unknown clients and unregistered redirect URIs", async () => {
    const app = createApp(smart);
    expect((await app.request(authorizeUrl({ client_id: "unknown" }))).status).toBe(400);
    expect(
      (await app.request(authorizeUrl({ client_id: "public-app", redirect_uri: "http://localhost:3000/evil" }))).status,
    ).toBe(400);
  });

  it("drops scopes a client may not have", async () => {
    const app = createApp(smart);
    const { verifier, challenge } = pkce();
    const callback = await completeAuthorize(
      app,
      authorizeUrl({
        client_id: "public-app",
        scope: "launch/patient patient/*.rs user/*.cruds",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    const body = await (
      await token(app, {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: app_redirect,
        client_id: "public-app",
        code_verifier: verifier,
      })
    ).json();
    expect(body.scope).toBe("launch/patient patient/*.rs");
  });

  it("requires confidential clients to authenticate, without PKCE", async () => {
    const app = createApp(smart);
    const res = await app.request(authorizeUrl({ client_id: "server-app", scope: "patient/*.rs" }));
    const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
    const params = { grant_type: "authorization_code", code, redirect_uri: app_redirect };
    expect((await token(app, { ...params, client_id: "server-app" })).status).toBe(401);
    const ok = await token(app, params, {
      Authorization: `Basic ${Buffer.from("server-app:s3cret").toString("base64")}`,
    });
    expect(ok.status).toBe(200);
  });
});

describe("SMART refresh, introspect, and revoke", () => {
  async function tokens(app: Hono) {
    const { verifier, challenge } = pkce();
    const callback = await completeAuthorize(
      app,
      authorizeUrl({
        scope: "launch/patient patient/*.rs offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    return (
      await token(app, {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: app_redirect,
        client_id: "demo-app",
        code_verifier: verifier,
      })
    ).json();
  }
  const post = (app: Hono, path: string, params: Record<string, string>): Promise<JsonResponse> =>
    app.request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

  it("refreshes with the same context and allows narrowing scopes only", async () => {
    const app = createApp();
    const first = await tokens(app);
    const refreshed = await (
      await token(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "demo-app" })
    ).json();
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(refreshed).toMatchObject({ patient: "p1", refresh_token: first.refresh_token });
    const narrowed = await (
      await token(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "demo-app",
        scope: "patient/*.rs",
      })
    ).json();
    expect(narrowed.scope).toBe("patient/*.rs");
    const wider = await (
      await token(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "demo-app",
        scope: "user/*.rs",
      })
    ).json();
    expect(wider.error).toBe("invalid_scope");
  });

  it("introspects live tokens and revokes them", async () => {
    const app = createApp();
    const issued = await tokens(app);
    const active = await (await post(app, "/auth/introspect", { token: issued.access_token })).json();
    expect(active).toMatchObject({
      active: true,
      client_id: "demo-app",
      patient: "p1",
      scope: "launch/patient patient/*.rs offline_access",
    });
    expect((await post(app, "/auth/revoke", { token: issued.refresh_token })).status).toBe(200);
    expect((await (await post(app, "/auth/introspect", { token: issued.access_token })).json()).active).toBe(false);
    expect(
      (
        await (
          await token(app, { grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: "demo-app" })
        ).json()
      ).error,
    ).toBe("invalid_grant");
    expect((await (await post(app, "/auth/introspect", { token: "nope" })).json()).active).toBe(false);
  });
});

describe("SMART configuration", () => {
  it("lets vendors move the endpoints", async () => {
    const app = new Hono();
    registerFhirRoutes(app, new Store(), {
      baseUrl: "http://localhost:4101",
      basePath: "/api/FHIR/R4",
      smart: { paths: { authorize: "/oauth2/authorize", token: "/oauth2/token" } },
    });
    const config = await (
      (await app.request("http://localhost:4101/api/FHIR/R4/.well-known/smart-configuration")) as JsonResponse
    ).json();
    expect(config.authorization_endpoint).toBe("http://localhost:4101/oauth2/authorize");
    expect(config.token_endpoint).toBe("http://localhost:4101/oauth2/token");
    expect(config.issuer).toBe("http://localhost:4101/api/FHIR/R4");
  });

  it("validates fhir.smart in config", () => {
    expect(() => createApp({ clients: [{ client_id: "", redirect_uris: [app_redirect] }] })).toThrow("client_id");
    expect(() => createApp({ clients: [{ client_id: "x", redirect_uris: [] }] })).toThrow("redirect_uris");
  });
});
