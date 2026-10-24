import { FhirError } from "./outcome.js";
import { parseSearch } from "./search.js";
import type { GuardedOperations } from "./operations.js";
import type { FhirResource, WriteResult } from "./store.js";

// Conditional create, update, and delete (FHIR R4 3.1.0.4.3, 3.1.0.7.1, 3.1.0.8.1), shared by the REST routes and
// by batch and transaction Bundles. Matching runs the search with the request's SMART access applied.

export type SearchFn = (type: string, params: Array<[string, string]>) => FhirResource;

/** Search criteria from an If-None-Exist header or the query of a conditional URL. */
export function criteria(query: string): Array<[string, string]> {
  return [...new URLSearchParams(query.replace(/^.*?\?/, ""))];
}

/** The ids of the resources the criteria match. */
/** Unknown criteria would be ignored by a search and match everything, so conditional criteria are strict. */
export function assertKnownCriteria(type: string, params: Array<[string, string]>): void {
  parseSearch(type, params, { strict: true });
}

export function matchIds(search: SearchFn, type: string, params: Array<[string, string]>): string[] {
  if (params.length === 0) throw new FhirError(400, "required", "A conditional interaction needs search criteria");
  assertKnownCriteria(type, params);
  const bundle = search(type, params) as FhirResource & {
    total?: number;
    entry?: Array<{ resource: FhirResource; search?: { mode?: string } }>;
  };
  const ids = (bundle.entry ?? []).filter((e) => e.search?.mode === "match").map((e) => e.resource.id!);
  // The search pages its results, so the total decides whether more than one resource matched.
  if ((bundle.total ?? ids.length) > 1)
    throw new FhirError(412, "multiple-matches", `The criteria match ${bundle.total} ${type} resources`);
  return ids;
}

export type ConditionalCreateResult =
  | { created: WriteResult }
  | { existing: { id: string; versionId: number; lastUpdated: string; resource: FhirResource } };

/** Create unless the criteria match a resource; one match returns that resource instead. */
export function conditionalCreate(
  ops: GuardedOperations,
  search: SearchFn,
  type: string,
  body: unknown,
  ifNoneExist: string,
  assignedId?: string,
): ConditionalCreateResult {
  const [id] = matchIds(search, type, criteria(ifNoneExist));
  if (id === undefined) return { created: ops.create(type, body, assignedId) };
  const record = ops.read(type, id);
  return {
    existing: { id, versionId: record.version_id, lastUpdated: record.last_updated, resource: record.resource },
  };
}

/** Update the one matching resource, or create one when nothing matches. */
export function conditionalUpdate(
  ops: GuardedOperations,
  search: SearchFn,
  type: string,
  params: Array<[string, string]>,
  body: unknown,
  ifMatch?: string,
  assignedId?: string,
): WriteResult {
  const [id] = matchIds(search, type, params);
  const bodyId = body && typeof body === "object" ? (body as FhirResource).id : undefined;
  if (id !== undefined) {
    if (bodyId !== undefined && bodyId !== id)
      throw new FhirError(400, "invalid", `The resource id ${bodyId} does not match the matched ${type}/${id}`);
    return ops.update(type, id, { ...(body as FhirResource), id }, ifMatch);
  }
  // No match: an id in the body makes this an update as create; otherwise the server assigns one.
  if (bodyId !== undefined) return ops.update(type, bodyId, body, ifMatch);
  return ops.create(type, body, assignedId);
}

/** Delete the one matching resource; nothing matching is a successful no-op. */
export function conditionalDelete(
  ops: GuardedOperations,
  search: SearchFn,
  type: string,
  params: Array<[string, string]>,
): { versionId?: number } {
  const [id] = matchIds(search, type, params);
  return id === undefined ? {} : ops.delete(type, id);
}
