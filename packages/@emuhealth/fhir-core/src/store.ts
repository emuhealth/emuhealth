import { randomUUID } from "node:crypto";
import type { Collection, Entity, Store } from "@emulators/core";
import { FhirError } from "./outcome.js";
import { isR4ResourceType } from "./resource-types.js";
import { applyJsonPatch } from "./json-patch.js";

export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: { versionId?: string; lastUpdated?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type FhirMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** Current version of a resource. Deleted resources stay as tombstones with `resource: null`. */
export interface FhirResourceRecord extends Entity {
  key: string;
  resource_type: string;
  fhir_id: string;
  version_id: number;
  last_updated: string;
  resource: FhirResource | null;
}

/** One entry per version, used for vread and _history. */
export interface FhirHistoryRecord extends Entity {
  key: string;
  resource_type: string;
  fhir_id: string;
  version_id: number;
  last_updated: string;
  method: FhirMethod;
  resource: FhirResource | null;
}

export interface WriteResult {
  resource: FhirResource;
  versionId: number;
  lastUpdated: string;
  created: boolean;
}

export interface HistoryOptions {
  type?: string;
  id?: string;
  since?: string;
  count?: number;
}

const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

export function assertResourceType(type: string): void {
  if (!isR4ResourceType(type)) throw new FhirError(404, "not-supported", `Unknown resource type "${type}"`);
}

export function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new FhirError(400, "value", `Invalid resource id "${id}"`);
}

function assertResourceBody(body: unknown, type: string): asserts body is FhirResource {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new FhirError(400, "structure", "Request body must be a FHIR resource JSON object");
  const resourceType = (body as FhirResource).resourceType;
  if (typeof resourceType !== "string") throw new FhirError(400, "required", "Resource is missing resourceType");
  if (resourceType !== type)
    throw new FhirError(400, "invalid", `Resource type "${resourceType}" does not match the URL type "${type}"`);
}

function versionMatches(ifMatch: string | undefined, versionId: number): boolean {
  if (ifMatch === undefined) return true;
  const match = /^(?:W\/)?"?([^"]*)"?$/.exec(ifMatch.trim());
  return match?.[1] === String(versionId);
}

export class FhirStore {
  readonly resources: Collection<FhirResourceRecord>;
  readonly history: Collection<FhirHistoryRecord>;

  constructor(store: Store) {
    this.resources = store.collection<FhirResourceRecord>("fhir.resources", ["key", "resource_type"]);
    this.history = store.collection<FhirHistoryRecord>("fhir.history", ["key"]);
  }

  private current(type: string, id: string): FhirResourceRecord | undefined {
    return this.resources.findOneBy("key", `${type}/${id}`);
  }

  private write(type: string, id: string, body: FhirResource, method: FhirMethod): WriteResult {
    const existing = this.current(type, id);
    const versionId = (existing?.version_id ?? 0) + 1;
    const lastUpdated = new Date().toISOString();
    const { meta, ...rest } = structuredClone(body);
    const resource: FhirResource = {
      ...rest,
      resourceType: type,
      id,
      meta: { ...meta, versionId: String(versionId), lastUpdated },
    };
    const fields = {
      key: `${type}/${id}`,
      resource_type: type,
      fhir_id: id,
      version_id: versionId,
      last_updated: lastUpdated,
    };
    if (existing) this.resources.update(existing.id, { ...fields, resource });
    else this.resources.insert({ ...fields, resource });
    this.history.insert({ ...fields, method, resource });
    return {
      resource: structuredClone(resource),
      versionId,
      lastUpdated,
      created: !existing || existing.resource === null,
    };
  }

  /** Create a resource with a server-assigned id (or one chosen by a transaction). Any id in the body is ignored. */
  create(type: string, body: unknown, id: string = randomUUID()): WriteResult {
    assertResourceType(type);
    assertResourceBody(body, type);
    return this.write(type, id, body, "POST");
  }

  /** Remove every resource and version. */
  clear(): void {
    this.resources.clear();
    this.history.clear();
  }

  /** The current resource, or undefined when it is unknown or deleted. Never throws. */
  find(type: string, id: string): FhirResource | undefined {
    const record = this.current(type, id);
    return record?.resource ? structuredClone(record.resource) : undefined;
  }

  /** Current, non-deleted resources of a type, oldest first. */
  listCurrent(type: string): FhirResource[] {
    assertResourceType(type);
    return this.resources
      .findBy("resource_type", type)
      .filter((r): r is FhirResourceRecord & { resource: FhirResource } => r.resource !== null)
      .sort((a, b) => a.id - b.id)
      .map((r) => structuredClone(r.resource));
  }

  read(type: string, id: string): FhirResourceRecord & { resource: FhirResource } {
    assertResourceType(type);
    const record = this.current(type, id);
    if (!record) throw new FhirError(404, "not-found", `${type}/${id} is not known`);
    if (record.resource === null) throw new FhirError(410, "deleted", `${type}/${id} has been deleted`);
    return { ...record, resource: structuredClone(record.resource) };
  }

  vread(type: string, id: string, versionId: string): FhirHistoryRecord {
    assertResourceType(type);
    const version = this.history.findBy("key", `${type}/${id}`).find((h) => String(h.version_id) === versionId);
    if (!version) throw new FhirError(404, "not-found", `${type}/${id}/_history/${versionId} is not known`);
    if (version.resource === null)
      throw new FhirError(410, "deleted", `${type}/${id}/_history/${versionId} is a deleted version`);
    return { ...version, resource: structuredClone(version.resource) };
  }

  /** Update a resource, creating it with the given id when it does not exist. */
  update(type: string, id: string, body: unknown, ifMatch?: string): WriteResult {
    assertResourceType(type);
    assertId(id);
    assertResourceBody(body, type);
    if (body.id === undefined) throw new FhirError(400, "required", "Resource id is required for update");
    if (body.id !== id)
      throw new FhirError(400, "invalid", `Resource id "${body.id}" does not match the URL id "${id}"`);
    const existing = this.current(type, id);
    if (ifMatch !== undefined && (!existing || existing.resource === null))
      throw new FhirError(412, "conflict", `${type}/${id} does not exist, so If-Match cannot be satisfied`);
    if (existing && !versionMatches(ifMatch, existing.version_id))
      throw new FhirError(412, "conflict", `Version conflict: ${type}/${id} is at version ${existing.version_id}`);
    return this.write(type, id, body, "PUT");
  }

  patch(type: string, id: string, operations: unknown, ifMatch?: string): WriteResult {
    const current = this.read(type, id);
    if (!versionMatches(ifMatch, current.version_id))
      throw new FhirError(412, "conflict", `Version conflict: ${type}/${id} is at version ${current.version_id}`);
    const patched = applyJsonPatch(current.resource, operations);
    assertResourceBody(patched, type);
    if (patched.id !== id) throw new FhirError(400, "invalid", "JSON Patch must not change the resource id");
    return this.write(type, id, patched, "PATCH");
  }

  /** Logical delete. Deleting a missing or already deleted resource is a no-op. */
  delete(type: string, id: string, ifMatch?: string): { versionId?: number } {
    assertResourceType(type);
    const existing = this.current(type, id);
    if (!existing || existing.resource === null) return {};
    if (!versionMatches(ifMatch, existing.version_id))
      throw new FhirError(412, "conflict", `Version conflict: ${type}/${id} is at version ${existing.version_id}`);
    const versionId = existing.version_id + 1;
    const lastUpdated = new Date().toISOString();
    const fields = {
      key: existing.key,
      resource_type: type,
      fhir_id: id,
      version_id: versionId,
      last_updated: lastUpdated,
    };
    this.resources.update(existing.id, { ...fields, resource: null });
    this.history.insert({ ...fields, method: "DELETE", resource: null });
    return { versionId };
  }

  /** History entries, newest first. Returns the total before `count` is applied. */
  listHistory(options: HistoryOptions = {}): { total: number; entries: FhirHistoryRecord[] } {
    if (options.type) assertResourceType(options.type);
    let since: number | undefined;
    if (options.since !== undefined) {
      since = Date.parse(options.since);
      if (Number.isNaN(since)) throw new FhirError(400, "value", `Invalid _since value "${options.since}"`);
    }
    let entries =
      options.type && options.id
        ? this.history.findBy("key", `${options.type}/${options.id}`)
        : this.history.all().filter((h) => !options.type || h.resource_type === options.type);
    if (since !== undefined) entries = entries.filter((h) => Date.parse(h.last_updated) >= since);
    entries.sort((a, b) => b.last_updated.localeCompare(a.last_updated) || b.id - a.id);
    const total = entries.length;
    if (options.count !== undefined) entries = entries.slice(0, options.count);
    return { total, entries: entries.map((h) => structuredClone(h)) };
  }
}

export function getFhirStore(store: Store): FhirStore {
  return new FhirStore(store);
}
