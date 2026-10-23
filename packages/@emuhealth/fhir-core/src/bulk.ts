import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import { inPatientCompartment, type AccessGuard } from "./access.js";
import { FhirError } from "./outcome.js";
import { isResourceType } from "./resource-types.js";
import type { FhirResource, FhirStore } from "./store.js";

// FHIR Bulk Data Access (Flat FHIR) $export: system, Patient, and Group level, NDJSON output.

export const NDJSON = "application/fhir+ndjson";
const OUTPUT_FORMATS = new Set(["application/fhir+ndjson", "application/ndjson", "ndjson"]);

export interface ExportJob {
  id: string;
  /** The kick-off request URL, echoed in the manifest. */
  request: string;
  transactionTime: string;
  /** Downloads need a token from the same client when the kick-off used one. */
  requiresAccessToken: boolean;
  clientId?: string;
  /** NDJSON text per resource type. */
  files: Record<string, string>;
  counts: Record<string, number>;
}

export interface ExportRequest {
  level: "system" | "patient" | "group";
  /** Group level: the Group id. */
  groupId?: string;
  params: URLSearchParams;
  request: string;
}

function jobs(store: Store): Map<string, ExportJob> {
  let value = store.getData<Map<string, ExportJob>>("fhir.bulk.jobs");
  if (!value) {
    value = new Map();
    store.setData("fhir.bulk.jobs", value);
  }
  return value;
}

export function listExportJobs(store: Store): ExportJob[] {
  return [...jobs(store).values()];
}

export function getExportJob(store: Store, id: string): ExportJob | undefined {
  return jobs(store).get(id);
}

export function deleteExportJob(store: Store, id: string): boolean {
  return jobs(store).delete(id);
}

/** Group members that are Patients. */
function groupPatients(group: FhirResource): string[] {
  const members = (group.member as Array<{ entity?: { reference?: string } }> | undefined) ?? [];
  return members
    .map((m) => m.entity?.reference?.match(/(?:^|\/)Patient\/([^/]+)$/)?.[1])
    .filter((id): id is string => id !== undefined);
}

/** Validate the kick-off and build the export. The emulator completes jobs immediately. */
export function startExport(store: Store, fhir: FhirStore, guard: AccessGuard, req: ExportRequest): ExportJob {
  const { params } = req;
  const format = params.get("_outputFormat");
  if (format !== null && !OUTPUT_FORMATS.has(format))
    throw new FhirError(400, "not-supported", `Unsupported _outputFormat "${format}"; use ${NDJSON}`);
  if (params.has("_typeFilter")) throw new FhirError(400, "not-supported", "_typeFilter is not supported");
  if (params.has("_elements")) throw new FhirError(400, "not-supported", "_elements is not supported");
  let since: number | undefined;
  const sinceRaw = params.get("_since");
  if (sinceRaw !== null) {
    since = Date.parse(sinceRaw);
    if (Number.isNaN(since)) throw new FhirError(400, "value", `Invalid _since value "${sinceRaw}"`);
  }
  const requestedTypes = params.get("_type")?.split(",").filter(Boolean);
  for (const type of requestedTypes ?? [])
    if (!isResourceType(type, fhir.version))
      throw new FhirError(400, "value", `Unknown resource type "${type}" in _type`);
  // Explicitly requested types must be readable; without _type, export what the token can read.
  for (const type of requestedTypes ?? []) guard.require(type, "r");
  const readable = (type: string) => {
    try {
      guard.require(type, "r");
      return true;
    } catch {
      return false;
    }
  };

  let resources = fhir.listAllCurrent();
  if (req.level !== "system") {
    let patients: string[];
    if (req.level === "group") {
      guard.require("Group", "r");
      const group = fhir.read("Group", req.groupId!).resource;
      if (!guard.allows(group, "r")) throw new FhirError(404, "not-found", `Group/${req.groupId} is not known`);
      patients = groupPatients(group);
    } else patients = fhir.listCurrent("Patient").map((p) => p.id!);
    resources = resources.filter((r) => patients.some((id) => inPatientCompartment(r, id)));
  }
  resources = resources.filter(
    (r) =>
      (requestedTypes ? requestedTypes.includes(r.resourceType) : readable(r.resourceType)) &&
      guard.allows(r, "r") &&
      (since === undefined || Date.parse(String(r.meta?.lastUpdated)) >= since),
  );

  const files: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const r of resources) {
    files[r.resourceType] = (files[r.resourceType] ?? "") + `${JSON.stringify(r)}\n`;
    counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  }
  const job: ExportJob = {
    id: randomUUID(),
    request: req.request,
    transactionTime: new Date().toISOString(),
    requiresAccessToken: Boolean(guard.token),
    clientId: guard.token?.clientId,
    files,
    counts,
  };
  jobs(store).set(job.id, job);
  return job;
}

/** The completed-export manifest. */
export function exportManifest(job: ExportJob, fileUrl: (type: string) => string): Record<string, unknown> {
  return {
    transactionTime: job.transactionTime,
    request: job.request,
    requiresAccessToken: job.requiresAccessToken,
    output: Object.keys(job.files)
      .sort()
      .map((type) => ({ type, url: fileUrl(type), count: job.counts[type] })),
    error: [],
  };
}
