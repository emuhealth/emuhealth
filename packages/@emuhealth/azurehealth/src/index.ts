import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { FHIR_JSON, createFhirInstance, getFhirStore, operationOutcome, type FhirInstance } from "@emuhealth/fhir-core";

/**
 * Azure Health Data Services emulator (emuhealth is not affiliated with Microsoft): FHIR services in workspaces,
 * each a FHIR R4 server at /{workspace}-{fhirservice}, the path form of
 * https://{workspace}-{fhirservice}.fhir.azurehealthcareapis.com. Requests need an Entra ID Bearer token; with
 * an issuer configured (for example the emuhealth Microsoft emulator), tokens are verified against its JWKS.
 */
export interface AzureHealthSeedConfig {
  port?: number;
  /** Workspaces and their FHIR services. Default: workspace "synthetic" with FHIR service "fhir", preloaded. */
  workspaces?: Array<{ name: string; fhirServices?: Array<{ name: string; preload?: boolean }> }>;
  /** Verify Entra ID access tokens. Without it, any Bearer token is accepted. */
  entra?: {
    /** Token issuer, for example http://localhost:4006/<tenant>/v2.0 for the emuhealth Microsoft emulator. */
    issuer: string;
    /** JWKS URL. Default: from the issuer's OpenID configuration. */
    jwksUri?: string;
  };
}

const SERVICE_LABEL = "Azure Health Data Services";
const NAME = /^[a-z0-9]{3,24}$/;
type AnyContext = Context<AppEnv>;

interface FhirService {
  workspace: string;
  name: string;
  instance: FhirInstance;
}
interface Data {
  services: Map<string, FhirService>;
  entra?: { issuer: string; jwks: JWTVerifyGetKey };
}

const runtime = new WeakMap<
  Store,
  { data: Data; create(workspace: string, name: string, preload: boolean): FhirService }
>();

export const azurehealthPlugin: ServicePlugin = {
  name: "azurehealth",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/+$/, "");
    const data: Data = { services: new Map() };
    const create = (workspace: string, name: string, preload: boolean): FhirService => {
      const key = `${workspace}-${name}`;
      const service: FhirService = {
        workspace,
        name,
        instance: createFhirInstance({
          baseUrl: origin,
          basePath: `/${key}`,
          software: { name: "emuhealth Azure Health Data Services emulator" },
          description:
            "Emulates an Azure Health Data Services FHIR service with synthetic data. Not affiliated with Microsoft.",
          inspectorPath: false,
          generate: preload,
        }),
      };
      data.services.set(key, service);
      return service;
    };
    runtime.set(store, { data, create });

    const unauthorized = (c: AnyContext, audience: string, message: string) =>
      c.body(JSON.stringify(operationOutcome("login", message)), 401, {
        "Content-Type": FHIR_JSON,
        "WWW-Authenticate": `Bearer authorization_uri="${data.entra?.issuer ?? "https://login.microsoftonline.com/common"}", resource_id="${audience}", realm="${audience}"`,
        "x-ms-request-id": randomUUID(),
      });

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      app.on(method, "/:service{[a-z0-9]+-[a-z0-9]+}/:rest{.*}", async (c) => {
        const key = c.req.param("service");
        const service = data.services.get(key);
        if (!service)
          return c.body(JSON.stringify(operationOutcome("not-found", `FHIR service ${key} does not exist`)), 404, {
            "Content-Type": FHIR_JSON,
          });
        const audience = `${origin}/${key}`;
        // The capability statement and SMART discovery are public, as on Azure.
        const rest = c.req.param("rest");
        if (!(method === "GET" && (rest === "metadata" || rest.startsWith(".well-known/")))) {
          const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
          if (!bearer) return unauthorized(c, audience, "Authentication failed.");
          if (data.entra) {
            try {
              await jwtVerify(bearer, data.entra.jwks, {
                issuer: data.entra.issuer,
                audience: [audience, `${audience}/`],
              });
            } catch (err) {
              return unauthorized(
                c,
                audience,
                `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        const response = await service.instance.forward(c);
        const headers = new Headers(response.headers);
        headers.set("x-ms-request-id", randomUUID());
        return new Response(response.body, { status: response.status, headers });
      });

    app.get("/_inspector", (c) => {
      const rows = [...data.services.entries()].map(
        ([key, s]) =>
          `<tr><td>${escapeHtml(s.workspace)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(`${origin}/${key}`)}</td><td>${getFhirStore(s.instance.store).listCurrent("Patient").length}</td></tr>`,
      );
      const auth = data.entra
        ? `Tokens are verified against ${escapeHtml(data.entra.issuer)}.`
        : "Any Bearer token is accepted; set azurehealth.entra to verify Entra ID tokens.";
      const body = `<div class="inspector-section"><h2>FHIR services</h2><p>${auth}</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>workspace</th><th>FHIR service</th><th>URL</th><th>patients</th></tr></thead><tbody>${
        rows.length
          ? rows.join("")
          : '<tr><td colspan="4"><div class="inspector-empty">No FHIR services</div></td></tr>'
      }</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Azure Health Data Services inspector",
          [{ id: "services", label: "FHIR services", href: "/_inspector" }],
          "services",
          body,
          SERVICE_LABEL,
        ),
      );
    });
  },
  seed(store: Store): void {
    runtime.get(store)?.create("synthetic", "fhir", true);
  },
};

export function seedFromConfig(store: Store, _baseUrl: string, config: AzureHealthSeedConfig): void {
  const rt = runtime.get(store);
  if (!rt) throw new Error("azurehealth: register the plugin before seeding");
  if (config.entra !== undefined) {
    const { issuer, jwksUri } = config.entra ?? ({} as { issuer?: string; jwksUri?: string });
    if (typeof issuer !== "string" || !/^https?:\/\//.test(issuer))
      throw new Error("azurehealth.entra.issuer must be an http(s) URL");
    if (jwksUri !== undefined && !/^https?:\/\//.test(jwksUri))
      throw new Error("azurehealth.entra.jwksUri must be an http(s) URL");
    // Resolve the JWKS lazily from the issuer's OpenID configuration on first use.
    let remote: JWTVerifyGetKey | undefined;
    const jwks: JWTVerifyGetKey = async (header, token) => {
      if (!remote) {
        const uri =
          jwksUri ??
          (
            (await (await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`)).json()) as {
              jwks_uri: string;
            }
          ).jwks_uri;
        remote = createRemoteJWKSet(new URL(uri));
      }
      return remote(header, token);
    };
    rt.data.entra = { issuer, jwks };
  }
  if (config.workspaces === undefined) return;
  if (!Array.isArray(config.workspaces)) throw new Error("azurehealth.workspaces must be an array");
  rt.data.services.clear();
  for (const [i, ws] of config.workspaces.entries()) {
    if (typeof ws?.name !== "string" || !NAME.test(ws.name))
      throw new Error(`azurehealth.workspaces[${i}].name must be 3 to 24 lowercase letters and digits`);
    for (const [j, svc] of (ws.fhirServices ?? []).entries()) {
      if (typeof svc?.name !== "string" || !NAME.test(svc.name))
        throw new Error(
          `azurehealth.workspaces[${i}].fhirServices[${j}].name must be 3 to 24 lowercase letters and digits`,
        );
      rt.create(ws.name, svc.name, svc.preload ?? false);
    }
  }
}

export default azurehealthPlugin;
