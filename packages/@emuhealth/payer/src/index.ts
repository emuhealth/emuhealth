import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  FHIR_JSON,
  createFhirInstance,
  findAccessToken,
  generateSyntheticRecords,
  getFhirStore,
  operationOutcome,
  registerFhirRoutes,
  seedFromConfig as seedFhirFromConfig,
  seedTerminology,
  setSmartConfig,
  type FhirInstance,
  type FhirResource,
  type FhirSeedConfig,
  type GenerateOptions,
  type SmartClient,
} from "@emuhealth/fhir-core";
import { MEMBER_ID_SYSTEM, memberRecords } from "./carin.js";
import { generateDirectory } from "./directory.js";

export { memberId, memberRecords, payerOrganization, MEMBER_ID_SYSTEM, PAYER_ID } from "./carin.js";
export { generateDirectory, syntheticNpi } from "./directory.js";

/**
 * A synthetic health plan's interoperability APIs: the CMS patient access API with CARIN Blue Button data at /fhir
 * (SMART, tokens required), PDex payer-to-payer exchange there with $member-match, and a public Plan-Net provider
 * directory at /directory. Not affiliated with any payer.
 */
export const PAYER_FHIR_PATH = "/fhir";
export const DIRECTORY_PATH = "/directory";

export const DEFAULT_CLIENTS: SmartClient[] = [
  { client_id: "member-app", redirect_uris: ["http://localhost:3000/callback"] },
  { client_id: "synthetic-new-payer", client_secret: "synthetic-new-payer-secret" },
];

export interface PayerSeedConfig extends FhirSeedConfig {
  /** Load the Plan-Net directory (default true). */
  directory?: boolean;
}

/** The generated population as plan members: clinical records for PDex, plus CARIN member data. */
function seedMembers(store: Store, options: GenerateOptions = {}): void {
  const fhir = getFhirStore(store);
  const records = generateSyntheticRecords(options);
  const members = memberRecords(records);
  const replaced = new Set(members.map((r) => `${r.resourceType}/${r.id}`));
  for (const r of [...records.filter((x) => !replaced.has(`${x.resourceType}/${x.id}`)), ...members])
    fhir.update(r.resourceType, r.id!, r);
}

const directories = new WeakMap<Store, FhirInstance>();

function directoryFor(store: Store, baseUrl: string, load = true): FhirInstance {
  const instance = createFhirInstance({
    baseUrl,
    basePath: DIRECTORY_PATH,
    software: { name: "emuhealth payer emulator (Plan-Net directory)" },
    description: "A synthetic Plan-Net provider directory. Not affiliated with any payer.",
    inspectorPath: false,
  });
  if (load) {
    const fhir = getFhirStore(instance.store);
    for (const r of generateDirectory()) {
      if (r.resourceType === "Endpoint") r.address = `${baseUrl.replace(/\/$/, "")}${PAYER_FHIR_PATH}`;
      fhir.update(r.resourceType, r.id!, r);
    }
  }
  directories.set(store, instance);
  return instance;
}

export function seedFromConfig(store: Store, baseUrl: string, config: PayerSeedConfig): void {
  const { generate, directory, smart, ...rest } = config;
  if (generate !== undefined) {
    if (generate !== false && (typeof generate !== "object" || generate === null))
      throw new Error("payer.generate must be an object of generator options or false");
    getFhirStore(store).clear();
    seedTerminology(store);
    if (generate !== false) seedMembers(store, generate);
  }
  if (directory !== undefined) {
    if (typeof directory !== "boolean") throw new Error("payer.directory must be true or false");
    directoryFor(store, baseUrl, directory);
  }
  // Every member API request needs a token, as a CMS patient access API does.
  setSmartConfig(store, { ...smart, clients: smart?.clients ?? DEFAULT_CLIENTS, required: true });
  seedFhirFromConfig(store, baseUrl, rest);
}

type AnyContext = Context<AppEnv>;
const fhirJson = (c: AnyContext, body: unknown, status: number) =>
  c.body(JSON.stringify(body), status as never, { "Content-Type": FHIR_JSON });

type Parameters = {
  resourceType: "Parameters";
  parameter?: Array<{ name: string; resource?: FhirResource; valueIdentifier?: unknown }>;
};

/** HRex $member-match: find the one member the new payer's Patient and old Coverage describe. */
function memberMatch(store: Store, body: unknown): { status: number; body: unknown } {
  const params = body as Parameters;
  if (params?.resourceType !== "Parameters")
    return { status: 400, body: operationOutcome("invalid", "The body must be a Parameters resource") };
  const part = (name: string) =>
    params.parameter?.find((p) => p.name === name)?.resource as Record<string, any> | undefined;
  const patient = part("MemberPatient");
  const coverage = part("CoverageToMatch");
  const consent = part("Consent");
  if (!patient || !coverage)
    return { status: 400, body: operationOutcome("required", "MemberPatient and CoverageToMatch are required") };
  if (!consent)
    return { status: 400, body: operationOutcome("required", "A Consent is required for payer-to-payer exchange") };
  if (consent.status !== "active")
    return { status: 422, body: operationOutcome("processing", "The Consent is not active") };
  const memberIds = [
    coverage.subscriberId,
    ...((coverage.identifier ?? []) as Array<{ value?: string }>).map((i) => i.value),
  ].filter(Boolean);
  const family = String(patient.name?.[0]?.family ?? "").toLowerCase();
  const fhir = getFhirStore(store);
  const matches = fhir.listCurrent("Patient").filter((p: any) => {
    const ids = (p.identifier ?? []).filter((i: any) => i.system === MEMBER_ID_SYSTEM).map((i: any) => i.value);
    return (
      ids.some((id: string) => memberIds.includes(id)) &&
      p.birthDate === patient.birthDate &&
      (p.name ?? []).some((n: any) => String(n.family ?? "").toLowerCase() === family)
    );
  });
  if (matches.length !== 1)
    return {
      status: 422,
      body: operationOutcome(
        matches.length ? "multiple-matches" : "not-found",
        matches.length ? "More than one member matches" : "No unique member matches the request",
      ),
    };
  const match = matches[0] as any;
  const identifier = match.identifier.find((i: any) => i.system === MEMBER_ID_SYSTEM);
  return {
    status: 200,
    body: {
      resourceType: "Parameters",
      parameter: [
        { name: "MemberIdentifier", valueIdentifier: identifier },
        { name: "MemberId", valueReference: { reference: `Patient/${match.id}` } },
      ],
    },
  };
}

export const payerPlugin: ServicePlugin = {
  name: "payer",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    app.post(`${PAYER_FHIR_PATH}/Patient/$member-match`, async (c) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
      const token = bearer ? findAccessToken(store, bearer) : undefined;
      if (!token) return fhirJson(c, operationOutcome("login", "A payer-to-payer access token is required"), 401);
      if (!/(^|\s)system\//.test(token.scope))
        return fhirJson(c, operationOutcome("forbidden", "$member-match needs a system scope token"), 403);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fhirJson(c, operationOutcome("structure", "The body is not JSON"), 400);
      }
      const result = memberMatch(store, body);
      return fhirJson(c, result.body, result.status);
    });

    // The Plan-Net directory is public and read-only.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      app.on(method, `${DIRECTORY_PATH}/:rest{.*}`, (c) => {
        if (method !== "GET" && !(method === "POST" && c.req.param("rest").endsWith("/_search")))
          return fhirJson(c, operationOutcome("not-supported", "The provider directory is read-only"), 405);
        return (directories.get(store) ?? directoryFor(store, baseUrl)).forward(c);
      });

    registerFhirRoutes(app, store, {
      baseUrl,
      basePath: PAYER_FHIR_PATH,
      software: { name: "emuhealth payer emulator" },
      description:
        "A synthetic health plan's patient access (CARIN Blue Button) and payer-to-payer (PDex) API. Not affiliated with any payer.",
      smart: { patientAccess: true, clientCredentialsWithSecret: true },
    });
  },
  seed(store: Store, baseUrl: string): void {
    seedTerminology(store);
    seedMembers(store);
    directoryFor(store, baseUrl);
    setSmartConfig(store, { clients: DEFAULT_CLIENTS, required: true });
  },
};

export default payerPlugin;
