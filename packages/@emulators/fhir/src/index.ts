import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getFhirStore, type FhirResource } from "./store.js";

export { getFhirStore, type FhirResource, type FhirResourceRecord, type FhirStore } from "./store.js";

const DEFAULT_RESOURCE_TYPES = [
  "Patient",
  "Practitioner",
  "Organization",
  "Encounter",
  "Observation",
  "MedicationRequest",
  "Coverage",
  "Claim",
  "DiagnosticReport",
  "DocumentReference",
];

export interface FhirSeedConfig {
  port?: number;
  resources?: FhirResource[];
}

function fhirError(status: number, diagnostics: string) {
  return {
    status,
    body: {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: status === 404 ? "not-found" : "invalid",
          diagnostics,
        },
      ],
    },
  };
}

function newFhirId(resourceType: string): string {
  return `${resourceType.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceWithMetadata(
  resourceType: string,
  input: FhirResource,
  id = input.id ?? newFhirId(resourceType),
  previous?: FhirResource,
) {
  const now = new Date().toISOString();
  const version = Number(input.meta?.versionId ?? previous?.meta?.versionId ?? 0) + 1;
  return {
    ...input,
    resourceType,
    id,
    meta: {
      ...input.meta,
      versionId: String(version),
      lastUpdated: now,
    },
  };
}

function deepValues(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => deepValues(item));
  if (isObject(value)) return Object.values(value).flatMap((item) => deepValues(item));
  return [String(value)];
}

function valueAtPath(value: unknown, path: string): unknown {
  if (!isObject(value)) return undefined;
  const parts = path.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      current = current.map((item) => (isObject(item) ? item[part] : undefined));
    } else if (isObject(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function referenceValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.reference === "string") return value.reference;
  return undefined;
}

function matchesSearch(resource: FhirResource, key: string, expected: string): boolean {
  if (key === "_id") return resource.id === expected;

  const direct = valueAtPath(resource, key);
  const directValues = deepValues(direct);
  if (directValues.includes(expected)) return true;

  if (key === "patient" || key === "subject") {
    const subject = referenceValue(resource.subject);
    return subject === expected || subject === `Patient/${expected}`;
  }

  return deepValues(resource).includes(expected);
}

function searchBundle(baseUrl: string, resourceType: string, resources: FhirResource[], selfUrl: string) {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    link: [{ relation: "self", url: selfUrl }],
    entry: resources.map((resource) => ({
      fullUrl: `${baseUrl}/${resourceType}/${resource.id}`,
      resource,
    })),
  };
}

function capabilityStatement(baseUrl: string, resourceTypes: string[]) {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["application/fhir+json", "json"],
    rest: [
      {
        mode: "server",
        resource: resourceTypes.map((type) => ({
          type,
          interaction: [
            { code: "read" },
            { code: "search-type" },
            { code: "create" },
            { code: "update" },
            { code: "delete" },
          ],
        })),
      },
    ],
    implementation: {
      title: "emulate FHIR R4",
      url: baseUrl,
    },
  };
}

function smartConfiguration(baseUrl: string) {
  return {
    issuer: baseUrl,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    capabilities: ["launch-standalone", "client-public", "permission-patient"],
  };
}

function resourceTypes(store: Store): string[] {
  const seeded = getFhirStore(store).resources.all().map((record) => record.resourceType);
  return [...new Set([...DEFAULT_RESOURCE_TYPES, ...seeded])].sort();
}

export function seedFromConfig(store: Store, _baseUrl: string, config: FhirSeedConfig): void {
  const fs = getFhirStore(store);
  for (const resource of config.resources ?? []) {
    if (!resource.resourceType) continue;
    const fhirId = resource.id ?? newFhirId(resource.resourceType);
    const existing = fs.resources
      .findBy("resourceType", resource.resourceType)
      .find((record) => record.fhirId === fhirId);
    if (existing) continue;
    fs.resources.insert({
      resourceType: resource.resourceType,
      fhirId,
      resource: resourceWithMetadata(resource.resourceType, resource, fhirId),
    });
  }
}

function fhirRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const fs = () => getFhirStore(store);

  app.get("/metadata", (c) => c.json(capabilityStatement(baseUrl, resourceTypes(store))));

  app.get("/.well-known/smart-configuration", (c) => c.json(smartConfiguration(baseUrl)));

  app.get("/:resourceType", (c) => {
    const resourceType = c.req.param("resourceType");
    const params = new URL(c.req.url).searchParams;
    let resources = fs()
      .resources.findBy("resourceType", resourceType)
      .map((record) => record.resource);

    for (const [key, expected] of params.entries()) {
      if (key.startsWith("_")) continue;
      resources = resources.filter((resource) => matchesSearch(resource, key, expected));
    }

    const parsedCount = Number(params.get("_count") ?? resources.length);
    const parsedOffset = Number(params.get("_offset") ?? 0);
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const count = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : resources.length;
    const paged = resources.slice(offset, offset + count);

    return c.json(searchBundle(baseUrl, resourceType, paged, c.req.url));
  });

  app.post("/:resourceType", async (c) => {
    const resourceType = c.req.param("resourceType");
    const body = (await c.req.json()) as FhirResource;
    if (!isObject(body)) {
      const err = fhirError(400, "FHIR resource body must be a JSON object");
      return c.json(err.body, err.status);
    }
    if (body.resourceType && body.resourceType !== resourceType) {
      const err = fhirError(400, "FHIR resourceType must match the request path");
      return c.json(err.body, err.status);
    }

    const resource = resourceWithMetadata(resourceType, body);
    fs().resources.insert({ resourceType, fhirId: resource.id!, resource });
    c.header("Location", `${baseUrl}/${resourceType}/${resource.id}`);
    return c.json(resource, 201);
  });

  app.get("/:resourceType/:id", (c) => {
    const resourceType = c.req.param("resourceType");
    const id = c.req.param("id");
    const record = fs()
      .resources.findBy("resourceType", resourceType)
      .find((candidate) => candidate.fhirId === id);
    if (!record) {
      const err = fhirError(404, `${resourceType}/${id} was not found`);
      return c.json(err.body, err.status);
    }
    return c.json(record.resource);
  });

  app.put("/:resourceType/:id", async (c) => {
    const resourceType = c.req.param("resourceType");
    const id = c.req.param("id");
    const body = (await c.req.json()) as FhirResource;
    if (!isObject(body)) {
      const err = fhirError(400, "FHIR resource body must be a JSON object");
      return c.json(err.body, err.status);
    }
    if (body.resourceType && body.resourceType !== resourceType) {
      const err = fhirError(400, "FHIR resourceType must match the request path");
      return c.json(err.body, err.status);
    }

    const existing = fs()
      .resources.findBy("resourceType", resourceType)
      .find((candidate) => candidate.fhirId === id);
    const resource = resourceWithMetadata(resourceType, body, id, existing?.resource);
    if (existing) {
      fs().resources.update(existing.id, { resource });
      return c.json(resource);
    }

    fs().resources.insert({ resourceType, fhirId: id, resource });
    return c.json(resource, 201);
  });

  app.delete("/:resourceType/:id", (c) => {
    const resourceType = c.req.param("resourceType");
    const id = c.req.param("id");
    const record = fs()
      .resources.findBy("resourceType", resourceType)
      .find((candidate) => candidate.fhirId === id);
    if (!record) {
      const err = fhirError(404, `${resourceType}/${id} was not found`);
      return c.json(err.body, err.status);
    }
    fs().resources.delete(record.id);
    return c.body(null, 204);
  });
}

export const fhirPlugin: ServicePlugin = {
  name: "fhir",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    fhirRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {},
};

export default fhirPlugin;
