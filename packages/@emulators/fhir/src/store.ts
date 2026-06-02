import type { Collection, Entity, Store } from "@emulators/core";

export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FhirResourceRecord extends Entity {
  resourceType: string;
  fhirId: string;
  resource: FhirResource;
}

export interface FhirStore {
  resources: Collection<FhirResourceRecord>;
}

export function getFhirStore(store: Store): FhirStore {
  return {
    resources: store.collection<FhirResourceRecord>("fhir.resources", ["resourceType", "fhirId"]),
  };
}
