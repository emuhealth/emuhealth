import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  FhirError,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedSyntheticRecords,
  seedTerminology,
  type FhirResource,
  type FhirSeedConfig,
} from "@emuhealth/fhir-core";
import { bookAppointment, findAppointments, seedSchedules, type SchedulingOptions } from "./scheduling.js";

export { findAppointments, bookAppointment, seedSchedules, type SchedulingOptions } from "./scheduling.js";

/**
 * Epic FHIR R4 emulator (emuhealth is not affiliated with Epic Systems). It serves the shared FHIR server under
 * Epic's URL shape, with Epic's OAuth 2.0 paths, Epic's informational OperationOutcome on empty searches, an
 * `__epic.dstu2.patient` token field, and Appointment/$find and $book scheduling.
 */
export const EPIC_FHIR_PATH = "/api/FHIR/R4";
export const EPIC_OAUTH_PATHS = {
  authorize: "/oauth2/authorize",
  token: "/oauth2/token",
  introspect: "/oauth2/introspect",
  revoke: "/oauth2/revoke",
};
/** The code system Epic uses for its OperationOutcome detail codes. */
export const EPIC_OUTCOME_SYSTEM = "urn:oid:1.2.840.114350.1.13.0.1.7.2.657369";

export interface EpicSeedConfig extends FhirSeedConfig {
  /** Slots for Appointment/$find and $book. */
  scheduling?: SchedulingOptions;
}

/** Epic answers a search with no matches with a Bundle holding an informational OperationOutcome (code 4101). */
export function epicSearchBundle(bundle: FhirResource): FhirResource {
  const entries = (bundle.entry as unknown[] | undefined) ?? [];
  if (bundle.total !== 0 || entries.length > 0) return bundle;
  return {
    ...bundle,
    entry: [
      {
        resource: {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "warning",
              code: "processing",
              details: {
                coding: [
                  { system: EPIC_OUTCOME_SYSTEM, code: "4101", display: "Resource request returns no results." },
                ],
                text: "Resource request returns no results.",
              },
            },
          ],
        },
        search: { mode: "outcome" },
      },
    ],
  };
}

export function seedFromConfig(store: Store, baseUrl: string, config: EpicSeedConfig): void {
  const { scheduling, ...fhirConfig } = config;
  if (scheduling !== undefined && (typeof scheduling !== "object" || scheduling === null))
    throw new Error("epic.scheduling must be an object");
  seedFhirFromConfig(store, baseUrl, fhirConfig);
  // A configured population replaces the default one, Schedules and Slots included, so seed them again.
  seedSchedules(store, scheduling);
}

type AnyContext = Context<AppEnv>;

function fhirJson(c: AnyContext, body: unknown, status = 200): Response {
  return c.body(JSON.stringify(body), status as never, { "Content-Type": FHIR_JSON });
}

async function operation(c: AnyContext, run: (body: unknown) => FhirResource, status = 200): Promise<Response> {
  try {
    const body = await c.req.json().catch(() => {
      throw new FhirError(400, "invalid", "The request body must be JSON");
    });
    return fhirJson(c, run(body), status);
  } catch (err) {
    if (err instanceof FhirError) return fhirJson(c, operationOutcome(err.code, err.message), err.status);
    throw err;
  }
}

export const epicPlugin: ServicePlugin = {
  name: "epic",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const base = `${baseUrl.replace(/\/+$/, "")}${EPIC_FHIR_PATH}`;
    // Registered before the FHIR routes so they win over the generic operation handling.
    app.post(`${EPIC_FHIR_PATH}/Appointment/$find`, (c) =>
      operation(c, (body) => findAppointments(store, c.req.header("Authorization"), body, base)),
    );
    app.post(`${EPIC_FHIR_PATH}/Appointment/$book`, (c) =>
      operation(c, (body) => bookAppointment(store, c.req.header("Authorization"), body)),
    );
    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: EPIC_FHIR_PATH,
      software: { name: "emuhealth Epic emulator" },
      description: "Emulates the Epic FHIR R4 API for local development with synthetic data. Not affiliated with Epic.",
      smart: {
        paths: EPIC_OAUTH_PATHS,
        tokenExtras: (grant) => (grant.patient ? { "__epic.dstu2.patient": grant.patient } : {}),
      },
      searchBundle: epicSearchBundle,
    });
    const notFound = (c: AnyContext) =>
      fhirJson(
        c,
        operationOutcome("not-supported", `${c.req.method} ${c.req.path} is not a supported Epic FHIR interaction`),
        404,
      );
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) app.on(method, "/:rest{(?!_emulate).*}", notFound);
  },
  seed(store: Store): void {
    seedTerminology(store);
    seedSyntheticRecords(store);
    seedSchedules(store);
  },
};

export default epicPlugin;
