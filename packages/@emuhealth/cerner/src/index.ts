import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedSyntheticRecords,
  seedTerminology,
  type FhirSeedConfig,
} from "@emuhealth/fhir-core";

/**
 * Oracle Health (Cerner) Millennium FHIR R4 emulator (emuhealth is not affiliated with Oracle). It serves the shared
 * FHIR server under the Millennium tenant URL shape, with persona OAuth endpoints on the authorization host,
 * system accounts that authenticate with a client secret, and Millennium's required search parameters.
 */

/** The synthetic tenant id. Millennium tenants are UUIDs; this one is not a real tenant. */
export const CERNER_TENANT = "5e7e0000-0000-4000-8000-000000000001";
export const CERNER_FHIR_PATH = `/r4/${CERNER_TENANT}`;
const OAUTH = `/tenants/${CERNER_TENANT}/protocols/oauth2/profiles/smart-v1`;
export const CERNER_OAUTH_PATHS = {
  authorize: `${OAUTH}/personas/provider/authorize`,
  token: `${OAUTH}/token`,
  introspect: `${OAUTH}/introspect`,
  revoke: `${OAUTH}/revoke`,
};

/** Search parameters Millennium requires, per resource type: a search needs at least one of them. */
export const REQUIRED_SEARCH_PARAMS: Record<string, string[]> = {
  AllergyIntolerance: ["patient", "_id"],
  CarePlan: ["patient", "subject", "_id"],
  CareTeam: ["patient", "_id"],
  Condition: ["patient", "subject", "_id"],
  Device: ["patient", "_id"],
  DiagnosticReport: ["patient", "subject", "_id"],
  DocumentReference: ["patient", "subject", "_id"],
  Encounter: ["patient", "subject", "_id", "identifier"],
  Goal: ["patient", "_id"],
  Immunization: ["patient", "_id"],
  MedicationRequest: ["patient", "_id"],
  Observation: ["patient", "subject", "_id"],
  Patient: ["_id", "identifier", "name", "family", "given", "birthdate", "phone", "email", "address-postalcode"],
  Procedure: ["patient", "subject", "_id"],
  Provenance: ["target", "_id"],
};

export type CernerSeedConfig = FhirSeedConfig;

export function seedFromConfig(store: Store, baseUrl: string, config: CernerSeedConfig): void {
  seedFhirFromConfig(store, baseUrl, config);
}

type AnyContext = Context<AppEnv>;

const fhirJson = (c: AnyContext, body: unknown, status: number) =>
  c.body(JSON.stringify(body), status as never, { "Content-Type": FHIR_JSON });

export const cernerPlugin: ServicePlugin = {
  name: "cerner",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    // Millennium rejects searches without one of the required parameters.
    app.use(`${CERNER_FHIR_PATH}/:type{[A-Z][A-Za-z]+}`, async (c, next) => {
      const required = REQUIRED_SEARCH_PARAMS[c.req.param("type")];
      if (c.req.method !== "GET" || !required) return next();
      const params = new URL(c.req.url).searchParams;
      const given = [...params.keys()].map((k) => k.split(":")[0]);
      if (required.some((name) => given.includes(name))) return next();
      return fhirJson(
        c,
        operationOutcome("invalid", `A ${c.req.param("type")} search requires one of: ${required.join(", ")}`),
        400,
      );
    });

    // The patient persona has its own authorize URL; it runs the same flow.
    app.get(`${OAUTH}/personas/patient/authorize`, (c) => {
      const query = new URL(c.req.url).search;
      return c.redirect(`${CERNER_OAUTH_PATHS.authorize}${query}`, 307);
    });

    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: CERNER_FHIR_PATH,
      software: { name: "emuhealth Oracle Health emulator" },
      description:
        "Emulates the Oracle Health (Cerner) Millennium FHIR R4 API for local development with synthetic data. Not affiliated with Oracle.",
      smart: {
        paths: CERNER_OAUTH_PATHS,
        clientCredentialsWithSecret: true,
        tokenExtras: (grant) => ({
          tenant: CERNER_TENANT,
          ...(grant.fhirUser ? { username: grant.fhirUser.split("/")[1], user: grant.fhirUser.split("/")[1] } : {}),
        }),
      },
    });

    const notFound = (c: AnyContext) =>
      fhirJson(
        c,
        operationOutcome(
          "not-supported",
          `${c.req.method} ${c.req.path} is not a supported Millennium FHIR interaction`,
        ),
        404,
      );
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) app.on(method, "/:rest{(?!_emulate).*}", notFound);
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
  },
};

export default cernerPlugin;
