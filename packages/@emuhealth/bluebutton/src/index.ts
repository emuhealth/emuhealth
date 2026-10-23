import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  findAccessToken,
  generateSyntheticRecords,
  getFhirStore,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedTerminology,
  type FhirSeedConfig,
  type GenerateOptions,
} from "@emuhealth/fhir-core";
import { claimsFor } from "./claims.js";

export { claimsFor, syntheticMbi } from "./claims.js";

/**
 * CMS Blue Button 2.0 emulator (emuhealth is not affiliated with CMS): patient access OAuth at /v2/o, a userinfo
 * endpoint, and the FHIR R4 API at /v2/fhir with Patient, Coverage, and ExplanationOfBenefit for synthetic
 * Medicare beneficiaries.
 */
export const BB_FHIR_PATH = "/v2/fhir";
export const BB_OAUTH_PATHS = {
  authorize: "/v2/o/authorize/",
  token: "/v2/o/token/",
  introspect: "/v2/o/introspect/",
  revoke: "/v2/o/revoke_token/",
};
/** Blue Button serves patient data only: these are the resource types it exposes. */
const RESOURCE_TYPES = ["Patient", "Coverage", "ExplanationOfBenefit"];

export type BlueButtonSeedConfig = FhirSeedConfig;

/** Generated beneficiaries with their claims, keeping only what Blue Button exposes. */
function seedBeneficiaries(store: Store, options: GenerateOptions = {}): void {
  const fhir = getFhirStore(store);
  const records = generateSyntheticRecords(options);
  const claims = claimsFor(records);
  for (const r of [
    ...records.filter((x) => ["Patient", "Organization", "Practitioner"].includes(x.resourceType)),
    ...claims,
  ])
    fhir.update(r.resourceType, r.id!, r);
}

export function seedFromConfig(store: Store, baseUrl: string, config: BlueButtonSeedConfig): void {
  const { generate, ...rest } = config;
  if (generate !== undefined) {
    if (generate !== false && (typeof generate !== "object" || generate === null))
      throw new Error("bluebutton.generate must be an object of generator options or false");
    getFhirStore(store).clear();
    seedTerminology(store);
    if (generate !== false) seedBeneficiaries(store, generate);
  }
  seedFhirFromConfig(store, baseUrl, rest);
}

type AnyContext = Context<AppEnv>;

const fhirJson = (c: AnyContext, body: unknown, status: number) =>
  c.body(JSON.stringify(body), status as never, { "Content-Type": FHIR_JSON });

export const bluebuttonPlugin: ServicePlugin = {
  name: "bluebutton",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    // Blue Button is read-only patient access: tokens are required and only the three resource types exist.
    app.use(`${BB_FHIR_PATH}/:rest{.*}`, async (c, next) => {
      const rest = c.req.param("rest");
      if (rest === "metadata" || rest.startsWith(".well-known/")) return next();
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      if (!bearer || !findAccessToken(store, bearer))
        return fhirJson(
          c,
          operationOutcome("login", "Authentication credentials were not provided or are invalid."),
          401,
        );
      const type = rest.split(/[/?]/)[0];
      if (!RESOURCE_TYPES.includes(type))
        return fhirJson(c, operationOutcome("not-supported", `Blue Button does not serve ${type || "this path"}`), 404);
      if (c.req.method !== "GET")
        return fhirJson(c, operationOutcome("not-supported", "Blue Button is read-only"), 405);
      return next();
    });

    // OpenID userinfo for the signed-in beneficiary.
    app.get("/v2/connect/userinfo", (c) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const token = bearer ? findAccessToken(store, bearer) : undefined;
      if (!token?.patient) return c.json({ detail: "Authentication credentials were not provided." }, 401);
      const patient = getFhirStore(store).find("Patient", token.patient);
      const name = (patient?.name as Array<{ family?: string; given?: string[] }> | undefined)?.[0] ?? {};
      return c.json({
        sub: token.patient,
        patient: token.patient,
        name: `${name.given?.[0] ?? ""} ${name.family ?? ""}`.trim(),
        given_name: name.given?.[0] ?? "",
        family_name: name.family ?? "",
        iat: new Date().toISOString(),
      });
    });

    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: BB_FHIR_PATH,
      software: { name: "emuhealth Blue Button 2.0 emulator" },
      description:
        "Emulates the CMS Blue Button 2.0 API for local development with synthetic beneficiaries. Not affiliated with CMS.",
      smart: { paths: BB_OAUTH_PATHS, patientAccess: true },
    });

    app.on("GET", "/:rest{(?!_emulate).*}", (c) => c.json({ detail: "Not found." }, 404));
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedBeneficiaries(store);
  },
};

export default bluebuttonPlugin;
