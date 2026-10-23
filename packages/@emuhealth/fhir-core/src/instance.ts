import { Hono, Store, type Context } from "@emulators/core";
import { registerFhirRoutes, type FhirRouteOptions } from "./routes.js";
import { seedTerminology } from "./terminology.js";
import { generateSyntheticRecords, type GenerateOptions } from "./generator.js";
import { getFhirStore } from "./store.js";
import { recordsForVersion } from "./r5.js";
import { getFhirVersion } from "./version.js";

/**
 * A FHIR server with its own store, for cloud emulators that host many FHIR stores created at run time (AWS
 * HealthLake datastores, Google Cloud Healthcare FHIR stores, Azure FHIR services). Mount it by forwarding
 * requests under its base path with `forward`.
 */
export interface FhirInstance {
  app: Hono;
  store: Store;
  /** Pass a request on to this instance, without its Authorization header. */
  forward(c: Context<any, any>): Promise<Response>;
}

export interface FhirInstanceOptions extends FhirRouteOptions {
  /** Load the generated synthetic population (and terminology fixtures). Default false: start empty. */
  generate?: GenerateOptions | boolean;
}

export function createFhirInstance(options: FhirInstanceOptions): FhirInstance {
  const app = new Hono();
  const store = new Store();
  const { generate, ...routeOptions } = options;
  registerFhirRoutes(app, store, routeOptions);
  if (generate) {
    seedTerminology(store);
    const fhir = getFhirStore(store);
    const records = generateSyntheticRecords(generate === true ? {} : generate);
    for (const r of recordsForVersion(records, getFhirVersion(store))) fhir.update(r.resourceType, r.id!, r);
  }
  return {
    app,
    store,
    // The host authenticates the request with its own scheme (SigV4, Google or Entra tokens), so the instance
    // sees it without the Authorization header and does not mistake it for a SMART token.
    forward: async (c) => {
      const raw = c.req.raw;
      const headers = new Headers(raw.headers);
      headers.delete("authorization");
      const body = raw.method === "GET" || raw.method === "HEAD" ? undefined : await raw.arrayBuffer();
      return app.fetch(new Request(raw.url, { method: raw.method, headers, body }));
    },
  };
}
