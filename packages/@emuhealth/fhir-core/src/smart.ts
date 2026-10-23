import { createHash, randomBytes } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import type { Context, Hono, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderFormPostPage,
  renderUserButton,
} from "@emulators/core";
import { getFhirStore, type FhirResource } from "./store.js";

// SMART App Launch (decision 0010): discovery, authorize with pickers, EHR launch simulator, and tokens.

type AnyContext = Context<any, any>;

export interface SmartClient {
  client_id: string;
  /** Present for confidential clients that authenticate with a shared secret. */
  client_secret?: string;
  /** Public keys for private_key_jwt client authentication (SMART Backend Services and asymmetric apps). */
  jwks?: JSONWebKeySet;
  /** URL of the client's JWKS, as an alternative to an inline jwks. */
  jwks_uri?: string;
  /** Required for apps that use the authorization code flow; optional for backend-only clients. */
  redirect_uris?: string[];
  /** Space separated scopes the client may be granted. Requested scopes outside it are dropped. */
  scope?: string;
}

export interface SmartConfig {
  /** Registered clients. With none, any client_id and redirect_uri is accepted as a public client. */
  clients?: SmartClient[];
  /** Require PKCE (S256) for public clients. Default true. */
  requirePkce?: boolean;
  /** Require a valid token on every FHIR request (enforced by a later release). Default false. */
  required?: boolean;
}

export interface SmartPaths {
  authorize: string;
  token: string;
  introspect: string;
  revoke: string;
  launch: string;
  jwks: string;
}

export interface SmartRouteOptions {
  /** FHIR base URL including any base path, without a trailing slash. Used as `iss`. */
  base: string;
  basePath: string;
  /** Absolute paths on this server; defaults are under the FHIR base path (/auth/authorize, ...). */
  paths?: Partial<SmartPaths>;
  /** Vendor-specific fields to add to authorization code and refresh token responses. */
  tokenExtras?: (grant: SmartTokenGrant) => Record<string, unknown>;
}

/** What a token response is issued for, as passed to `tokenExtras`. */
export interface SmartTokenGrant {
  clientId: string;
  scope: string;
  patient?: string;
  encounter?: string;
  fhirUser?: string;
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  responseMode: string;
  codeChallenge: string;
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  /** Standalone launch shows the patient banner; EHR launch does not. */
  needPatientBanner: boolean;
  createdAt: number;
}

interface IssuedCode extends AuthorizeRequest {
  code: string;
}

interface LaunchContext {
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  createdAt: number;
}

export interface SmartToken {
  token: string;
  kind: "access" | "refresh";
  clientId: string;
  scope: string;
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 30 * 60_000;
const ACCESS_TTL_S = 3600;
const KID = "emuhealth-smart-1";
const BACKEND_TTL_S = 300;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASSERTION_ALGORITHMS = ["RS384", "ES384"];
const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const SERVICE_LABEL = "FHIR";

const keyPairPromise = generateKeyPair("RS256");

const randomId = () => randomBytes(24).toString("base64url");

function map<V>(store: Store, name: string): Map<string, V> {
  const key = `fhir.smart.${name}`;
  let value = store.getData<Map<string, V>>(key);
  if (!value) {
    value = new Map();
    store.setData(key, value);
  }
  return value;
}

export function getSmartConfig(store: Store): SmartConfig {
  return store.getData<SmartConfig>("fhir.smart.config") ?? {};
}

export function setSmartConfig(store: Store, config: SmartConfig): void {
  if (config.clients !== undefined && !Array.isArray(config.clients))
    throw new Error("fhir.smart.clients must be an array");
  for (const [i, client] of (config.clients ?? []).entries()) {
    if (typeof client?.client_id !== "string" || !client.client_id)
      throw new Error(`fhir.smart.clients[${i}].client_id is required`);
    const backend = client.jwks !== undefined || client.jwks_uri !== undefined;
    if (client.jwks !== undefined && !Array.isArray(client.jwks?.keys))
      throw new Error(`fhir.smart.clients[${i}].jwks must be a JWKS object with a keys array`);
    if (client.jwks_uri !== undefined && !/^https?:\/\//.test(client.jwks_uri))
      throw new Error(`fhir.smart.clients[${i}].jwks_uri must be an http(s) URL`);
    if (client.redirect_uris !== undefined && !Array.isArray(client.redirect_uris))
      throw new Error(`fhir.smart.clients[${i}].redirect_uris must be an array`);
    if (!backend && (client.redirect_uris ?? []).length === 0)
      throw new Error(`fhir.smart.clients[${i}].redirect_uris needs at least one URI (or jwks for a backend client)`);
  }
  store.setData("fhir.smart.config", config);
}

/** Live access and refresh tokens, for the inspector. */
export function listSmartTokens(store: Store): SmartToken[] {
  const now = Date.now();
  return [...map<SmartToken>(store, "tokens").values()].filter((t) => t.expiresAt > now);
}

/** Look up a live access token. Expired tokens are removed. */
export function findAccessToken(store: Store, token: string): SmartToken | undefined {
  const found = map<SmartToken>(store, "tokens").get(token);
  if (!found || found.kind !== "access") return undefined;
  if (found.expiresAt <= Date.now()) {
    map<SmartToken>(store, "tokens").delete(token);
    return undefined;
  }
  return found;
}

function scopes(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).filter(Boolean));
}

function filterScope(requested: string, client: SmartClient | undefined): string {
  if (!client?.scope) return requested;
  const allowed = scopes(client.scope);
  return [...scopes(requested)].filter((s) => allowed.has(s)).join(" ");
}

function displayName(resource: FhirResource): string {
  const name = (resource.name as Array<{ text?: string; given?: string[]; family?: string; prefix?: string[] }>)?.[0];
  if (!name) return `${resource.resourceType}/${resource.id}`;
  return name.text ?? [...(name.prefix ?? []), ...(name.given ?? []), name.family].filter(Boolean).join(" ");
}

function oauthJson(c: AnyContext, body: unknown, status = 200): Response {
  return c.json(body, status, { "Cache-Control": "no-store", Pragma: "no-cache" });
}

function oauthError(c: AnyContext, error: string, description: string, status = 400): Response {
  return oauthJson(c, { error, error_description: description }, status);
}

/** Mount SMART App Launch endpoints for a FHIR server. */
export function registerSmartRoutes(app: Hono<any>, store: Store, options: SmartRouteOptions): SmartPaths {
  const { base, basePath } = options;
  const paths: SmartPaths = {
    authorize: `${basePath}/auth/authorize`,
    token: `${basePath}/auth/token`,
    introspect: `${basePath}/auth/introspect`,
    revoke: `${basePath}/auth/revoke`,
    launch: `${basePath}/auth/launch`,
    jwks: `${basePath}/.well-known/jwks.json`,
    ...options.paths,
  };
  const origin = new URL(base).origin;
  const url = (path: string) => `${origin}${path}`;
  const selectPath = `${paths.authorize}/select`;

  function findClient(clientId: string): { client?: SmartClient; error?: string } {
    const clients = getSmartConfig(store).clients ?? [];
    if (clients.length === 0) return {};
    const client = clients.find((c) => c.client_id === clientId);
    return client ? { client } : { error: `The client_id "${clientId}" is not registered.` };
  }

  app.get(`${basePath}/.well-known/smart-configuration`, (c) =>
    c.json({
      issuer: base,
      jwks_uri: url(paths.jwks),
      authorization_endpoint: url(paths.authorize),
      token_endpoint: url(paths.token),
      introspection_endpoint: url(paths.introspect),
      revocation_endpoint: url(paths.revoke),
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGORITHMS,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "openid",
        "fhirUser",
        "launch",
        "launch/patient",
        "launch/encounter",
        "offline_access",
        "online_access",
        "patient/*.rs",
        "user/*.rs",
        "patient/*.read",
        "user/*.read",
        "system/*.rs",
        "system/*.read",
      ],
      capabilities: [
        "launch-ehr",
        "launch-standalone",
        "authorize-post",
        "client-public",
        "client-confidential-symmetric",
        "client-confidential-asymmetric",
        "context-ehr-patient",
        "context-ehr-encounter",
        "context-standalone-patient",
        "permission-patient",
        "permission-user",
        "permission-v1",
        "permission-v2",
        "permission-offline",
        "permission-online",
        "sso-openid-connect",
      ],
    }),
  );

  // OpenID Connect discovery for the id_token, relative to the issuer (the FHIR base URL).
  app.get(`${basePath}/.well-known/openid-configuration`, (c) =>
    c.json({
      issuer: base,
      jwks_uri: url(paths.jwks),
      authorization_endpoint: url(paths.authorize),
      token_endpoint: url(paths.token),
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "fhirUser"],
      claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "fhirUser"],
    }),
  );

  app.get(paths.jwks, async (c) => {
    const { publicKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    return c.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
  });

  // Authorization

  function redirectWithError(
    c: AnyContext,
    req: Pick<AuthorizeRequest, "redirectUri" | "state">,
    error: string,
    description: string,
  ) {
    const target = new URL(req.redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (req.state) target.searchParams.set("state", req.state);
    return c.redirect(target.toString(), 302);
  }

  function issueCode(c: AnyContext, req: AuthorizeRequest): Response {
    const code = randomId();
    map<IssuedCode>(store, "codes").set(code, { ...req, code, createdAt: Date.now() });
    if (req.responseMode === "form_post")
      return c.html(
        renderFormPostPage(req.redirectUri, { code, ...(req.state ? { state: req.state } : {}) }, SERVICE_LABEL),
      );
    const target = new URL(req.redirectUri);
    target.searchParams.set("code", code);
    if (req.state) target.searchParams.set("state", req.state);
    return c.redirect(target.toString(), 302);
  }

  function picker(c: AnyContext, requestId: string, kind: "practitioner" | "patient"): Response {
    const fhir = getFhirStore(store);
    const resources = fhir.listCurrent(kind === "patient" ? "Patient" : "Practitioner");
    const buttons = resources.map((r) => {
      const name = displayName(r);
      const mrn = (r.identifier as Array<{ value?: string }> | undefined)?.[0]?.value;
      return renderUserButton({
        letter: (name[0] ?? "?").toUpperCase(),
        login: name,
        name:
          kind === "patient"
            ? [r.gender, r.birthDate ? `born ${r.birthDate}` : undefined].filter(Boolean).join(", ")
            : `Practitioner/${r.id}`,
        email: kind === "patient" ? (mrn ? `MRN ${mrn}` : `Patient/${r.id}`) : undefined,
        formAction: selectPath,
        hiddenFields: { request: requestId, [kind]: r.id! },
      });
    });
    const title = kind === "patient" ? "Select a patient" : "Sign in as a practitioner";
    const subtitle =
      kind === "patient"
        ? "The app asked for a patient context. Choose a synthetic patient."
        : "The app asked who is signing in. Choose a synthetic practitioner.";
    const empty = `<p class="empty">No ${kind === "patient" ? "Patient" : "Practitioner"} resources in the FHIR store.</p>`;
    return c.html(renderCardPage(title, subtitle, buttons.length ? buttons.join("\n") : empty, SERVICE_LABEL));
  }

  /** Show the next picker the request still needs, or issue the code. */
  function continueAuthorization(c: AnyContext, requestId: string): Response {
    const req = map<AuthorizeRequest>(store, "requests").get(requestId);
    if (!req || req.createdAt + REQUEST_TTL_MS < Date.now())
      return c.html(
        renderErrorPage("Authorization expired", "Start the sign-in again from the app.", SERVICE_LABEL),
        400,
      );
    const granted = scopes(req.scope);
    const wantsUser =
      (granted.has("openid") && granted.has("fhirUser")) || [...granted].some((s) => s.startsWith("user/"));
    if (wantsUser && !req.fhirUser) return picker(c, requestId, "practitioner");
    if (granted.has("launch/patient") && !req.patient) return picker(c, requestId, "patient");
    map<AuthorizeRequest>(store, "requests").delete(requestId);
    return issueCode(c, req);
  }

  async function authorize(c: AnyContext): Promise<Response> {
    const params =
      c.req.method === "POST"
        ? Object.fromEntries(new URLSearchParams(await c.req.text()))
        : Object.fromEntries(new URL(c.req.url).searchParams);
    const clientId = params.client_id ?? "";
    const redirectUri = params.redirect_uri ?? "";
    if (!redirectUri || !/^https?:\/\//.test(redirectUri))
      return c.html(renderErrorPage("Missing redirect URI", "A valid redirect_uri is required.", SERVICE_LABEL), 400);
    const { client, error } = findClient(clientId);
    if (error) return c.html(renderErrorPage("Unknown application", error, SERVICE_LABEL), 400);
    if (client && !matchesRedirectUri(redirectUri, client.redirect_uris ?? []))
      return c.html(
        renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this client.", SERVICE_LABEL),
        400,
      );

    const state = params.state ?? "";
    const fail = (err: string, description: string) => redirectWithError(c, { redirectUri, state }, err, description);
    if ((params.response_type ?? "") !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (params.aud && params.aud.replace(/\/+$/, "") !== base)
      return fail("invalid_request", `aud must be this FHIR server (${base}).`);
    const method = params.code_challenge_method ?? "";
    if (params.code_challenge && method !== "S256")
      return fail("invalid_request", "Only code_challenge_method=S256 is supported.");
    const confidential = Boolean(client?.client_secret || client?.jwks || client?.jwks_uri);
    if (!params.code_challenge && !confidential && getSmartConfig(store).requirePkce !== false)
      return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");

    const scope = filterScope(params.scope ?? "", client);
    const req: AuthorizeRequest = {
      clientId,
      redirectUri,
      scope,
      state,
      nonce: params.nonce ?? "",
      responseMode: params.response_mode ?? "query",
      codeChallenge: params.code_challenge ?? "",
      needPatientBanner: true,
      createdAt: Date.now(),
    };
    if (params.launch) {
      const launch = map<LaunchContext>(store, "launches").get(params.launch);
      if (!launch) return fail("invalid_request", "Unknown or expired launch value.");
      if (!scopes(scope).has("launch")) return fail("invalid_scope", "EHR launch needs the launch scope.");
      Object.assign(req, { patient: launch.patient, encounter: launch.encounter, fhirUser: launch.fhirUser });
      req.needPatientBanner = false;
    }
    const requestId = randomId();
    map<AuthorizeRequest>(store, "requests").set(requestId, req);
    return continueAuthorization(c, requestId);
  }

  app.get(paths.authorize, (c) => authorize(c));
  app.post(paths.authorize, (c) => authorize(c));

  app.post(selectPath, async (c) => {
    const body = await c.req.parseBody();
    const requestId = bodyStr(body.request);
    const req = map<AuthorizeRequest>(store, "requests").get(requestId);
    if (req) {
      const fhir = getFhirStore(store);
      const practitioner = bodyStr(body.practitioner);
      const patient = bodyStr(body.patient);
      if (practitioner && fhir.find("Practitioner", practitioner)) req.fhirUser = `Practitioner/${practitioner}`;
      if (patient && fhir.find("Patient", patient)) req.patient = patient;
    }
    return continueAuthorization(c, requestId);
  });

  // EHR launch simulator

  function launchApp(c: AnyContext, launchUri: string, context: Omit<LaunchContext, "createdAt">): Response {
    const id = randomId();
    map<LaunchContext>(store, "launches").set(id, { ...context, createdAt: Date.now() });
    const target = new URL(launchUri);
    target.searchParams.set("iss", base);
    target.searchParams.set("launch", id);
    return c.redirect(target.toString(), 302);
  }

  function launch(c: AnyContext, params: Record<string, string>): Response {
    const launchUri = params.launch_uri ?? "";
    if (!/^https?:\/\//.test(launchUri))
      return c.html(
        renderErrorPage(
          "EHR launch",
          `Open ${paths.launch}?launch_uri=<your app launch URL> to launch an app as an EHR would. Add patient=<id>, encounter=<id>, or practitioner=<id> to skip the picker.`,
          SERVICE_LABEL,
        ),
        400,
      );
    const fhir = getFhirStore(store);
    const context: Omit<LaunchContext, "createdAt"> = {};
    if (params.practitioner && fhir.find("Practitioner", params.practitioner))
      context.fhirUser = `Practitioner/${params.practitioner}`;
    if (params.encounter && fhir.find("Encounter", params.encounter)) context.encounter = params.encounter;
    if (params.patient) {
      if (!fhir.find("Patient", params.patient))
        return c.html(
          renderErrorPage("Unknown patient", `Patient/${params.patient} is not in the FHIR store.`, SERVICE_LABEL),
          400,
        );
      context.patient = params.patient;
      return launchApp(c, launchUri, context);
    }
    const buttons = fhir.listCurrent("Patient").map((r) => {
      const name = displayName(r);
      return renderUserButton({
        letter: (name[0] ?? "?").toUpperCase(),
        login: name,
        name: [r.gender, r.birthDate ? `born ${r.birthDate}` : undefined].filter(Boolean).join(", "),
        email: `Patient/${r.id}`,
        formAction: paths.launch,
        hiddenFields: {
          launch_uri: launchUri,
          patient: r.id!,
          ...(params.practitioner ? { practitioner: params.practitioner } : {}),
        },
      });
    });
    return c.html(
      renderCardPage(
        "Launch app from the EHR",
        "Choose the patient whose chart the app opens in.",
        buttons.length ? buttons.join("\n") : '<p class="empty">No Patient resources in the FHIR store.</p>',
        SERVICE_LABEL,
      ),
    );
  }

  app.get(paths.launch, (c) => launch(c, Object.fromEntries(new URL(c.req.url).searchParams)));
  app.post(paths.launch, async (c) => launch(c, Object.fromEntries(new URLSearchParams(await c.req.text()))));

  // Tokens

  async function tokenRequest(
    c: AnyContext,
  ): Promise<{ params: Record<string, string>; clientId: string; secret?: string }> {
    const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
    const basic = c.req.header("Authorization");
    if (basic?.startsWith("Basic ")) {
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep > 0)
        return {
          params,
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          secret: decodeURIComponent(decoded.slice(sep + 1)),
        };
    }
    return { params, clientId: params.client_id ?? "", secret: params.client_secret };
  }

  /** Verify a private_key_jwt client assertion (SMART Backend Services). Returns the client id or an error. */
  async function verifyAssertion(assertion: string): Promise<{ clientId?: string; error?: string }> {
    let issuer: string | undefined;
    try {
      issuer = decodeJwt(assertion).iss;
    } catch {
      return { error: "client_assertion is not a JWT." };
    }
    const client = (getSmartConfig(store).clients ?? []).find((c) => c.client_id === issuer);
    if (!client || (!client.jwks && !client.jwks_uri))
      return { error: `No registered client "${issuer ?? ""}" with a jwks or jwks_uri.` };
    let keys: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
    if (client.jwks) keys = createLocalJWKSet(client.jwks);
    else {
      keys = remoteKeySets.get(client.jwks_uri!) ?? createRemoteJWKSet(new URL(client.jwks_uri!));
      remoteKeySets.set(client.jwks_uri!, keys as ReturnType<typeof createRemoteJWKSet>);
    }
    try {
      const { payload } = await jwtVerify(assertion, keys, {
        algorithms: ASSERTION_ALGORITHMS,
        issuer: client.client_id,
        subject: client.client_id,
        audience: url(paths.token),
        requiredClaims: ["exp", "jti"],
      });
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp! > now + 300 + 60) return { error: "client_assertion exp is more than 5 minutes ahead." };
      const jtis = map<number>(store, "jtis");
      for (const [jti, exp] of jtis) if (exp < now) jtis.delete(jti);
      const key = `${client.client_id}:${payload.jti}`;
      if (jtis.has(key)) return { error: "client_assertion jti was already used." };
      jtis.set(key, payload.exp!);
      return { clientId: client.client_id };
    } catch (err) {
      return { error: `client_assertion is invalid: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Authenticate the client of a token, introspect, or revoke request. Asymmetric and secret clients must prove
   * who they are; public clients only identify themselves.
   */
  async function authenticate(
    c: AnyContext,
  ): Promise<{ params: Record<string, string>; clientId: string; asymmetric: boolean; error?: string }> {
    const { params, clientId, secret } = await tokenRequest(c);
    if (params.client_assertion_type !== undefined || params.client_assertion !== undefined) {
      if (params.client_assertion_type !== ASSERTION_TYPE)
        return { params, clientId, asymmetric: false, error: `client_assertion_type must be ${ASSERTION_TYPE}.` };
      const verified = await verifyAssertion(params.client_assertion ?? "");
      if (verified.error) return { params, clientId, asymmetric: false, error: verified.error };
      if (params.client_id && params.client_id !== verified.clientId)
        return { params, clientId, asymmetric: false, error: "client_id does not match the client_assertion." };
      return { params, clientId: verified.clientId!, asymmetric: true };
    }
    const { client, error } = findClient(clientId);
    if (error) return { params, clientId, asymmetric: false, error };
    if (client?.jwks || client?.jwks_uri)
      return { params, clientId, asymmetric: false, error: "This client must authenticate with private_key_jwt." };
    if (client?.client_secret && !(secret && constantTimeSecretEqual(secret, client.client_secret)))
      return { params, clientId, asymmetric: false, error: "Client authentication failed." };
    return { params, clientId, asymmetric: false };
  }

  async function idToken(clientId: string, fhirUser: string, nonce: string): Promise<string> {
    const { privateKey } = await keyPairPromise;
    return new SignJWT({ fhirUser: `${base}/${fhirUser}`, ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
      .setIssuer(base)
      .setSubject(fhirUser)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(privateKey);
  }

  async function issueTokens(
    c: AnyContext,
    grant: {
      clientId: string;
      scope: string;
      patient?: string;
      encounter?: string;
      fhirUser?: string;
      nonce?: string;
      needPatientBanner?: boolean;
    },
    refreshToken?: string,
  ): Promise<Response> {
    const tokens = map<SmartToken>(store, "tokens");
    const context = {
      clientId: grant.clientId,
      scope: grant.scope,
      patient: grant.patient,
      encounter: grant.encounter,
      fhirUser: grant.fhirUser,
    };
    const accessToken = randomId();
    tokens.set(accessToken, {
      ...context,
      token: accessToken,
      kind: "access",
      expiresAt: Date.now() + ACCESS_TTL_S * 1000,
    });
    const granted = scopes(grant.scope);
    let refresh = refreshToken;
    if (!refresh && (granted.has("offline_access") || granted.has("online_access"))) {
      refresh = randomId();
      tokens.set(refresh, { ...context, token: refresh, kind: "refresh", expiresAt: Number.MAX_SAFE_INTEGER });
    }
    return oauthJson(c, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      scope: grant.scope,
      ...(grant.patient ? { patient: grant.patient, need_patient_banner: grant.needPatientBanner ?? true } : {}),
      ...(grant.encounter ? { encounter: grant.encounter } : {}),
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(granted.has("openid") && grant.fhirUser
        ? { id_token: await idToken(grant.clientId, grant.fhirUser, grant.nonce ?? "") }
        : {}),
      ...options.tokenExtras?.({
        clientId: grant.clientId,
        scope: grant.scope,
        patient: grant.patient,
        encounter: grant.encounter,
        fhirUser: grant.fhirUser,
      }),
    });
  }

  app.post(paths.token, async (c) => {
    const { params, clientId, asymmetric, error: authError } = await authenticate(c);
    if (authError) return oauthError(c, "invalid_client", authError, 401);

    if (params.grant_type === "client_credentials") {
      // SMART Backend Services: asymmetric clients only, system scopes only, short-lived tokens, no refresh.
      if (!asymmetric)
        return oauthError(c, "invalid_client", "client_credentials needs private_key_jwt client authentication.", 401);
      const client = findClient(clientId).client;
      const scope = [...scopes(filterScope(params.scope ?? "", client))]
        .filter((s) => s.startsWith("system/"))
        .join(" ");
      if (!scope) return oauthError(c, "invalid_scope", "Request at least one system/ scope this client may use.");
      const accessToken = randomId();
      map<SmartToken>(store, "tokens").set(accessToken, {
        token: accessToken,
        kind: "access",
        clientId,
        scope,
        expiresAt: Date.now() + BACKEND_TTL_S * 1000,
      });
      return oauthJson(c, { access_token: accessToken, token_type: "Bearer", expires_in: BACKEND_TTL_S, scope });
    }

    if (params.grant_type === "authorization_code") {
      const codes = map<IssuedCode>(store, "codes");
      const issued = codes.get(params.code ?? "");
      codes.delete(params.code ?? "");
      if (!issued || issued.createdAt + CODE_TTL_MS < Date.now())
        return oauthError(c, "invalid_grant", "Authorization code is invalid, expired, or already used.");
      if (issued.clientId !== clientId) return oauthError(c, "invalid_grant", "The code was issued to another client.");
      if (issued.redirectUri !== params.redirect_uri)
        return oauthError(c, "invalid_grant", "redirect_uri does not match the authorization request.");
      if (issued.codeChallenge) {
        const verifier = params.code_verifier ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!verifier || challenge !== issued.codeChallenge)
          return oauthError(c, "invalid_grant", "code_verifier does not match the code_challenge.");
      }
      return issueTokens(c, issued);
    }

    if (params.grant_type === "refresh_token") {
      const stored = map<SmartToken>(store, "tokens").get(params.refresh_token ?? "");
      if (!stored || stored.kind !== "refresh" || stored.clientId !== clientId)
        return oauthError(c, "invalid_grant", "Refresh token is invalid or revoked.");
      let scope = stored.scope;
      if (params.scope) {
        const original = scopes(stored.scope);
        const requested = [...scopes(params.scope)];
        if (requested.some((s) => !original.has(s)))
          return oauthError(c, "invalid_scope", "A refresh cannot add scopes that were not granted.");
        scope = requested.join(" ");
      }
      return issueTokens(c, { ...stored, scope }, stored.token);
    }

    return oauthError(
      c,
      "unsupported_grant_type",
      "Supported grants: authorization_code, refresh_token, client_credentials.",
    );
  });

  app.post(paths.introspect, async (c) => {
    const { params, clientId, error: authError } = await authenticate(c);
    if (authError && (clientId || params.client_assertion)) return oauthError(c, "invalid_client", authError, 401);
    const found = findAccessToken(store, params.token ?? "");
    if (!found) return oauthJson(c, { active: false });
    return oauthJson(c, {
      active: true,
      scope: found.scope,
      client_id: found.clientId,
      token_type: "Bearer",
      exp: Math.floor(found.expiresAt / 1000),
      ...(found.patient ? { patient: found.patient } : {}),
      ...(found.encounter ? { encounter: found.encounter } : {}),
      ...(found.fhirUser ? { fhirUser: `${base}/${found.fhirUser}`, sub: found.fhirUser } : {}),
    });
  });

  app.post(paths.revoke, async (c) => {
    const { params, clientId, error: authError } = await authenticate(c);
    if (authError && (clientId || params.client_assertion)) return oauthError(c, "invalid_client", authError, 401);
    const tokens = map<SmartToken>(store, "tokens");
    const target = tokens.get(params.token ?? "");
    if (target) {
      tokens.delete(target.token);
      // Revoking a refresh token also ends the access tokens it produced for the same grant.
      if (target.kind === "refresh")
        for (const t of [...tokens.values()])
          if (
            t.kind === "access" &&
            t.clientId === target.clientId &&
            t.patient === target.patient &&
            t.fhirUser === target.fhirUser
          )
            tokens.delete(t.token);
    }
    return c.body(null, 200);
  });

  return paths;
}
