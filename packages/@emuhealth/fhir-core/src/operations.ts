import type { AccessGuard } from "./access.js";
import { applyJsonPatch } from "./json-patch.js";
import { FhirError } from "./outcome.js";
import type { FhirHistoryRecord, FhirResource, FhirResourceRecord, FhirStore, WriteResult } from "./store.js";

/** Store operations with SMART access checks applied. HTTP routes and Bundle entries both go through these. */
export interface GuardedOperations {
  guard: AccessGuard;
  read(type: string, id: string): FhirResourceRecord & { resource: FhirResource };
  vread(type: string, id: string, versionId: string): FhirHistoryRecord;
  create(type: string, body: unknown, id?: string): WriteResult;
  update(type: string, id: string, body: unknown, ifMatch?: string): WriteResult;
  patch(type: string, id: string, operations: unknown, ifMatch?: string): WriteResult;
  delete(type: string, id: string, ifMatch?: string): { versionId?: number };
}

const isResource = (body: unknown, type: string): body is FhirResource =>
  !!body && typeof body === "object" && !Array.isArray(body) && (body as FhirResource).resourceType === type;

/** Resources the token may not see look like they do not exist. */
function hidden(type: string, id: string): FhirError {
  return new FhirError(404, "not-found", `${type}/${id} is not known`);
}

export function guardedOperations(fhir: FhirStore, guard: AccessGuard): GuardedOperations {
  return {
    guard,
    read(type, id) {
      guard.require(type, "r");
      const record = fhir.read(type, id);
      if (!guard.allows(record.resource, "r")) throw hidden(type, id);
      return record;
    },
    vread(type, id, versionId) {
      guard.require(type, "r");
      const version = fhir.vread(type, id, versionId);
      if (version.resource && !guard.allows(version.resource, "r")) throw hidden(type, id);
      return version;
    },
    create(type, body, id) {
      guard.require(type, "c");
      if (isResource(body, type)) guard.requireWritable(body, "c");
      return fhir.create(type, body, id);
    },
    update(type, id, body, ifMatch) {
      const existing = fhir.find(type, id);
      if (existing) {
        guard.require(type, "u");
        guard.requireWritable(existing, "u");
      } else guard.require(type, "c");
      if (isResource(body, type)) guard.requireWritable({ ...body, id }, existing ? "u" : "c");
      return fhir.update(type, id, body, ifMatch);
    },
    patch(type, id, operations, ifMatch) {
      guard.require(type, "u");
      const current = fhir.read(type, id);
      if (!guard.allows(current.resource, "r") && !guard.allows(current.resource, "u")) throw hidden(type, id);
      guard.requireWritable(current.resource, "u");
      guard.requireWritable(applyJsonPatch(current.resource, operations), "u");
      return fhir.patch(type, id, operations, ifMatch);
    },
    delete(type, id, ifMatch) {
      guard.require(type, "d");
      const existing = fhir.find(type, id);
      if (existing) guard.requireWritable(existing, "d");
      return fhir.delete(type, id, ifMatch);
    },
  };
}
