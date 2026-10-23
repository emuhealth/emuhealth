import { Hono, Store, type Context } from "@emulators/core";
import { registerFhirRoutes, type FhirRouteOptions } from "./routes.js";
import { seedTerminology } from "./terminology.js";
import { generateSyntheticRecords, type GenerateOptions } from "./generator.js";
import { getFhirStore } from "./store.js";

/**
 * A FHIR server with its own store, for cloud emulators that host many FHIR stores created at run time (AWS
 * HealthLake datastores, Google Cloud Healthcare FHIR stores, Azure FHIR services). Mount it by forwarding
 * requests under its base path with `forward`.
 */
export interface FhirInstance {
  app: Hono;
  store: Store;
  /** Pass a request on to this instance. */
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
    for (const r of generateSyntheticRecords(generate === true ? {} : generate)) fhir.update(r.resourceType, r.id!, r);
  }
  return {
    app,
    store,
    forward: (c) => app.fetch(c.req.raw),
  };
}
