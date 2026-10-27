import { randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import type { GenerateOptions } from "@emuhealth/fhir-core";
import {
  extrinsicObject,
  NS,
  parseSubmitObjects,
  registryErrorList,
  registryPackage,
  registryResponse,
  sha1,
  STATUS_APPROVED,
  STATUS_DEPRECATED,
  XdsError,
  type DocumentEntry,
  type Submission,
} from "./ebrim.js";
import { HOME_COMMUNITY_ID, REPOSITORY_ID, seedDocuments } from "./data.js";
import {
  documentBytes,
  faultResponse,
  parseSoap,
  SoapFault,
  soapResponse,
  type SoapRequest,
  type SoapResponse,
} from "./soap.js";
import { childrenNamed, el, local, textEl, type XmlElement } from "./xml.js";

export { ASSIGNING_AUTHORITY, HOME_COMMUNITY_ID, REPOSITORY_ID, patientCx, seedDocuments } from "./data.js";
export { parseXml } from "./xml.js";

/**
 * IHE document sharing over SOAP 1.2: an XDS.b Document Registry (ITI-18 stored query, ITI-42 register) and
 * Document Repository (ITI-41 provide and register, ITI-43 retrieve), and an XCA Responding Gateway (ITI-38, ITI-39)
 * over the same documents. MTOM/XOP requests get MTOM responses.
 */
export const ACTIONS = {
  provideAndRegister: "urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-b",
  register: "urn:ihe:iti:2007:RegisterDocumentSet-b",
  storedQuery: "urn:ihe:iti:2007:RegistryStoredQuery",
  retrieve: "urn:ihe:iti:2007:RetrieveDocumentSet",
  crossGatewayQuery: "urn:ihe:iti:2007:CrossGatewayQuery",
  crossGatewayRetrieve: "urn:ihe:iti:2007:CrossGatewayRetrieve",
} as const;

export const QUERIES = {
  findDocuments: "urn:uuid:14d4debf-8f97-4251-9a74-a90016b0af0d",
  getDocuments: "urn:uuid:5c4f972b-d56b-40ac-a5fc-c8ca9b40b9d4",
  getSubmissionSets: "urn:uuid:51224314-5390-4169-9b91-b1980040715a",
} as const;

export interface XdsSeedConfig {
  port?: number;
  /** The patients and their documents come from the shared population (decision 0018); false starts empty. */
  generate?: GenerateOptions | false;
  /** More patient ids (CX, such as 123^^^&1.2.3&ISO) to accept in submissions. */
  patientIds?: string[];
}

interface XdsState {
  documents: DocumentEntry[];
  submissions: Submission[];
  patients: Set<string>;
}

const KEY = "xds.state";
const stateOf = (store: Store): XdsState => {
  let state = store.getData<XdsState>(KEY);
  if (!state) {
    const seeded = seedDocuments();
    state = { documents: seeded.documents, submissions: seeded.submissions, patients: new Set(seeded.patients) };
    store.setData(KEY, state);
  }
  return state;
};

export function seedFromConfig(store: Store, _baseUrl: string, config: XdsSeedConfig): void {
  const state = stateOf(store);
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("xds.generate must be generator options or false");
    const seeded =
      config.generate === false ? { documents: [], submissions: [], patients: [] } : seedDocuments(config.generate);
    state.documents = seeded.documents;
    state.submissions = seeded.submissions;
    state.patients = new Set(seeded.patients);
  }
  if (config.patientIds !== undefined) {
    if (!Array.isArray(config.patientIds) || config.patientIds.some((p) => typeof p !== "string"))
      throw new Error("xds.patientIds must be an array of CX patient ids");
    for (const id of config.patientIds) state.patients.add(id);
  }
}

// Stored query parameters: 'value' or ('a','b') lists.
function queryParams(query: XmlElement): Map<string, string[]> {
  const params = new Map<string, string[]>();
  for (const slot of childrenNamed(query, "Slot")) {
    const values = slot.children.flatMap((list) => list.children.map((v) => v.text.trim()));
    const items = values.flatMap((v) =>
      v
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((x) => x.trim().replace(/^'|'$/g, ""))
        .filter(Boolean),
    );
    params.set(slot.attrs.name, [...(params.get(slot.attrs.name) ?? []), ...items]);
  }
  return params;
}

function storedQuery(state: XdsState, request: XmlElement, home?: string): string {
  const query = childrenNamed(request, "AdhocQuery")[0];
  const returnType = childrenNamed(request, "ResponseOption")[0]?.attrs.returnType ?? "LeafClass";
  const wrap = (errors: XdsError[], objects: string[]) =>
    el(
      "query:AdhocQueryResponse",
      {
        "xmlns:query": NS.query,
        "xmlns:rim": NS.rim,
        "xmlns:rs": NS.rs,
        status: errors.length
          ? "urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Failure"
          : "urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Success",
      },
      errors.length ? registryErrorList(errors) : undefined,
      el("rim:RegistryObjectList", {}, ...objects),
    );
  if (!query) return wrap([new XdsError("XDSRegistryError", "AdhocQueryRequest has no AdhocQuery")], []);
  if (home && query.attrs.home && query.attrs.home !== HOME_COMMUNITY_ID)
    return wrap([new XdsError("XDSUnknownCommunity", `Unknown home community ${query.attrs.home}`)], []);
  const params = queryParams(query);
  let found: DocumentEntry[];
  if (query.attrs.id === QUERIES.findDocuments) {
    const patient = params.get("$XDSDocumentEntryPatientId")?.[0];
    const statuses = params.get("$XDSDocumentEntryStatus");
    if (!patient || !statuses?.length)
      return wrap(
        [
          new XdsError(
            "XDSStoredQueryParamNumber",
            "FindDocuments needs $XDSDocumentEntryPatientId and $XDSDocumentEntryStatus",
          ),
        ],
        [],
      );
    const codeFilter = (name: string, pick: (d: DocumentEntry) => { code: string; scheme: string }) => {
      const wanted = params.get(name);
      return (d: DocumentEntry) =>
        !wanted?.length ||
        wanted.some((w) => {
          const [code, , scheme] = w.split("^");
          return pick(d).code === code && (!scheme || pick(d).scheme === scheme);
        });
    };
    const from = params.get("$XDSDocumentEntryCreationTimeFrom")?.[0];
    const to = params.get("$XDSDocumentEntryCreationTimeTo")?.[0];
    found = state.documents
      .filter((d) => d.patientId === patient && statuses.includes(d.status))
      .filter(codeFilter("$XDSDocumentEntryClassCode", (d) => d.codes.classCode))
      .filter(codeFilter("$XDSDocumentEntryTypeCode", (d) => d.codes.typeCode))
      .filter((d) => (!from || d.creationTime >= from) && (!to || d.creationTime < to));
  } else if (query.attrs.id === QUERIES.getDocuments) {
    const uuids = params.get("$XDSDocumentEntryEntryUUID");
    const uniqueIds = params.get("$XDSDocumentEntryUniqueId");
    if (!uuids?.length && !uniqueIds?.length)
      return wrap(
        [
          new XdsError(
            "XDSStoredQueryParamNumber",
            "GetDocuments needs $XDSDocumentEntryEntryUUID or $XDSDocumentEntryUniqueId",
          ),
        ],
        [],
      );
    found = state.documents.filter((d) => uuids?.includes(d.entryUUID) || uniqueIds?.includes(d.uniqueId));
  } else if (query.attrs.id === QUERIES.getSubmissionSets) {
    const uuids = params.get("$uuid");
    if (!uuids?.length) return wrap([new XdsError("XDSStoredQueryParamNumber", "GetSubmissionSets needs $uuid")], []);
    const sets = state.submissions.filter((s) => s.documents.some((d) => uuids.includes(d)));
    return wrap(
      [],
      sets.flatMap((set) =>
        returnType === "ObjectRef"
          ? [el("rim:ObjectRef", { id: set.entryUUID, home })]
          : [
              registryPackage(set, home),
              ...set.documents
                .filter((d) => uuids.includes(d))
                .map((d) =>
                  el("rim:Association", {
                    associationType: "urn:oasis:names:tc:ebxml-regrep:AssociationType:HasMember",
                    id: `urn:uuid:${randomUUID()}`,
                    objectType: "urn:oasis:names:tc:ebxml-regrep:ObjectType:RegistryObject:Association",
                    sourceObject: set.entryUUID,
                    targetObject: d,
                    home,
                  }),
                ),
            ],
      ),
    );
  } else return wrap([new XdsError("XDSUnknownStoredQuery", `Unsupported stored query ${query.attrs.id}`)], []);
  return wrap(
    [],
    found.map((d) =>
      returnType === "ObjectRef" ? el("rim:ObjectRef", { id: d.entryUUID, home }) : extrinsicObject(d, home),
    ),
  );
}

function submit(state: XdsState, submitRequest: XmlElement, contents?: Map<string, Buffer>): XdsError[] {
  let parsed;
  try {
    parsed = parseSubmitObjects(submitRequest);
  } catch (error) {
    if (error instanceof XdsError) return [error];
    throw error;
  }
  const errors: XdsError[] = [];
  const set = parsed.submission!;
  if (!state.patients.has(set.patientId))
    errors.push(new XdsError("XDSUnknownPatientId", `Unknown patient ${set.patientId}`, set.entryUUID));
  const added: DocumentEntry[] = [];
  for (const doc of parsed.documents) {
    if (doc.patientId !== set.patientId)
      errors.push(
        new XdsError("XDSPatientIdDoesNotMatch", "The DocumentEntry and SubmissionSet patients differ", doc.symbolicId),
      );
    let content: Buffer | undefined;
    if (contents) {
      content = contents.get(doc.symbolicId);
      if (!content) {
        errors.push(new XdsError("XDSMissingDocument", `No document content for ${doc.symbolicId}`, doc.symbolicId));
        continue;
      }
    }
    const hash = content ? sha1(content) : doc.hash;
    const size = content ? content.length : doc.size;
    if (content && ((doc.hash && doc.hash !== hash) || (doc.size !== undefined && doc.size !== size)))
      errors.push(
        new XdsError("XDSRepositoryMetadataError", "The size or hash does not match the document", doc.symbolicId),
      );
    const existing = state.documents.find((d) => d.uniqueId === doc.uniqueId);
    if (existing)
      errors.push(
        existing.hash === hash
          ? new XdsError(
              "XDSDuplicateUniqueIdInRegistry",
              `Document ${doc.uniqueId} is already registered`,
              doc.symbolicId,
            )
          : new XdsError(
              "XDSNonIdenticalHash",
              `Document ${doc.uniqueId} exists with different content`,
              doc.symbolicId,
            ),
      );
    if (!hash || size === undefined)
      errors.push(
        new XdsError("XDSRegistryMetadataError", "A registered DocumentEntry needs size and hash", doc.symbolicId),
      );
    const { symbolicId: _symbolicId, ...entry } = doc;
    added.push({
      ...entry,
      size: size ?? 0,
      hash: hash ?? "",
      repositoryUniqueId: REPOSITORY_ID,
      submissionSet: set.entryUUID,
      content: content ?? Buffer.alloc(0),
    });
  }
  if (errors.length) return errors;
  // Replacements: an RPLC association deprecates the document it replaces.
  const list = submitRequest.children.find((c) => local(c.name) === "RegistryObjectList")!;
  for (const assoc of childrenNamed(list, "Association"))
    if (assoc.attrs.associationType === "urn:ihe:iti:2007:AssociationType:RPLC") {
      const old = state.documents.find((d) => d.entryUUID === assoc.attrs.targetObject);
      if (old) old.status = STATUS_DEPRECATED;
    }
  state.documents.push(...added);
  state.submissions.push({ ...set, documents: added.map((d) => d.entryUUID) });
  return [];
}

function retrieve(state: XdsState, request: XmlElement, attach: (data: Buffer) => string, cross: boolean): string {
  const errors: XdsError[] = [];
  const responses: string[] = [];
  for (const req of childrenNamed(request, "DocumentRequest")) {
    const value = (name: string) => childrenNamed(req, name)[0]?.text.trim();
    const uniqueId = value("DocumentUniqueId") ?? "";
    const home = value("HomeCommunityId");
    if (cross && home && home !== HOME_COMMUNITY_ID) {
      errors.push(new XdsError("XDSUnknownCommunity", `Unknown home community ${home}`, uniqueId));
      continue;
    }
    if (value("RepositoryUniqueId") !== REPOSITORY_ID) {
      errors.push(
        new XdsError("XDSUnknownRepositoryId", `Unknown repository ${value("RepositoryUniqueId")}`, uniqueId),
      );
      continue;
    }
    const doc = state.documents.find((d) => d.uniqueId === uniqueId);
    if (!doc) {
      errors.push(new XdsError("XDSDocumentUniqueIdError", `No document ${uniqueId}`, uniqueId));
      continue;
    }
    responses.push(
      el(
        "xdsb:DocumentResponse",
        {},
        cross ? textEl("xdsb:HomeCommunityId", HOME_COMMUNITY_ID) : undefined,
        textEl("xdsb:RepositoryUniqueId", REPOSITORY_ID),
        textEl("xdsb:DocumentUniqueId", doc.uniqueId),
        textEl("xdsb:mimeType", doc.mimeType),
        el("xdsb:Document", {}, attach(doc.content)),
      ),
    );
  }
  const status = !errors.length ? "Success" : responses.length ? "PartialSuccess" : "Failure";
  return el(
    "xdsb:RetrieveDocumentSetResponse",
    { "xmlns:xdsb": NS.xdsb, "xmlns:rs": NS.rs },
    el(
      "rs:RegistryResponse",
      {
        status: `urn:${status === "PartialSuccess" ? "ihe:iti:2007" : "oasis:names:tc:ebxml-regrep"}:ResponseStatusType:${status}`,
      },
      errors.length ? registryErrorList(errors) : undefined,
    ),
    ...responses,
  );
}

export function handleSoap(store: Store, request: SoapRequest): SoapResponse {
  const state = stateOf(store);
  const respond = (action: string, build: (attach: (data: Buffer) => string) => string) =>
    soapResponse(request, `${action}Response`, build);
  switch (request.action) {
    case ACTIONS.provideAndRegister: {
      if (local(request.body.name) !== "ProvideAndRegisterDocumentSetRequest")
        throw new SoapFault("Sender", "Expected a ProvideAndRegisterDocumentSetRequest");
      const submitRequest = childrenNamed(request.body, "SubmitObjectsRequest")[0];
      if (!submitRequest) throw new SoapFault("Sender", "The request has no SubmitObjectsRequest");
      const contents = new Map(
        childrenNamed(request.body, "Document").map((d) => [d.attrs.id, documentBytes(d, request.attachments)]),
      );
      return respond(request.action, () => registryResponse(submit(state, submitRequest, contents)));
    }
    case ACTIONS.register: {
      if (local(request.body.name) !== "SubmitObjectsRequest")
        throw new SoapFault("Sender", "Expected a SubmitObjectsRequest");
      return respond(request.action, () => registryResponse(submit(state, request.body)));
    }
    case ACTIONS.storedQuery:
    case ACTIONS.crossGatewayQuery: {
      if (local(request.body.name) !== "AdhocQueryRequest")
        throw new SoapFault("Sender", "Expected an AdhocQueryRequest");
      const home = request.action === ACTIONS.crossGatewayQuery ? HOME_COMMUNITY_ID : undefined;
      return respond(request.action, () => storedQuery(state, request.body, home));
    }
    case ACTIONS.retrieve:
    case ACTIONS.crossGatewayRetrieve: {
      if (local(request.body.name) !== "RetrieveDocumentSetRequest")
        throw new SoapFault("Sender", "Expected a RetrieveDocumentSetRequest");
      return respond(request.action, (attach) =>
        retrieve(state, request.body, attach, request.action === ACTIONS.crossGatewayRetrieve),
      );
    }
    default:
      throw new SoapFault("Sender", `Unsupported action ${request.action}`);
  }
}

function inspector(store: Store, tab: string): string {
  const state = stateOf(store);
  const tabs = [
    { id: "documents", label: `Documents (${state.documents.length})`, href: "/_inspector?tab=documents" },
    { id: "submissions", label: `Submission sets (${state.submissions.length})`, href: "/_inspector?tab=submissions" },
  ];
  const table = (headers: string[], rows: string[], empty: string) =>
    `<div class="inspector-scroll"><table class="inspector-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
      rows.length
        ? rows.join("")
        : `<tr><td colspan="${headers.length}"><div class="inspector-empty">${empty}</div></td></tr>`
    }</tbody></table></div>`;
  const body =
    tab === "submissions"
      ? `<div class="inspector-section"><h2>Submission sets</h2>${table(
          ["unique ID", "patient", "submitted", "documents"],
          state.submissions.map(
            (s) =>
              `<tr><td>${escapeHtml(s.uniqueId)}</td><td>${escapeHtml(s.patientId)}</td><td>${escapeHtml(s.submissionTime)}</td><td>${s.documents.length}</td></tr>`,
          ),
          "No submissions",
        )}</div>`
      : `<div class="inspector-section"><h2>Documents</h2>${table(
          ["title", "patient", "type", "unique ID", "status", ""],
          state.documents.map(
            (d) =>
              `<tr><td>${escapeHtml(d.title)}</td><td>${escapeHtml(d.patientId)}</td><td>${escapeHtml(d.codes.typeCode.display)}</td><td>${escapeHtml(d.uniqueId)}</td><td><span class="badge">${d.status === STATUS_APPROVED ? "approved" : "deprecated"}</span></td><td><a href="${escapeAttr(`/documents/${encodeURIComponent(d.uniqueId)}`)}">content</a></td></tr>`,
          ),
          "No documents",
        )}</div>`;
  return renderInspectorPage("XDS inspector", tabs, tab, body, "IHE XDS");
}

export const xdsPlugin: ServicePlugin = {
  name: "xds",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const endpoint = async (c: Context<AppEnv>) => {
      let request: SoapRequest | undefined;
      let response: SoapResponse;
      try {
        request = parseSoap(Buffer.from(await c.req.arrayBuffer()), c.req.header("Content-Type") ?? "");
        response = handleSoap(store, request);
      } catch (error) {
        if (!(error instanceof SoapFault)) throw error;
        response = faultResponse(request, error);
        return c.body(response.body as never, 400, { "Content-Type": response.contentType });
      }
      return c.body(response.body as never, 200, { "Content-Type": response.contentType });
    };
    for (const path of ["/xds/registry", "/xds/repository", "/xca/query", "/xca/retrieve"]) app.post(path, endpoint);

    // Helpers outside IHE for tests and browsing.
    app.get("/documents", (c) =>
      c.json({
        documents: stateOf(store).documents.map(({ content: _content, ...d }) => ({ ...d, content: undefined })),
      }),
    );
    app.get("/documents/:uniqueId", (c) => {
      const doc = stateOf(store).documents.find((d) => d.uniqueId === c.req.param("uniqueId"));
      return doc
        ? c.body(doc.content as never, 200, { "Content-Type": doc.mimeType })
        : c.json({ error: "Not found" }, 404);
    });
    app.get("/_inspector", (c) => c.html(inspector(store, new URL(c.req.url).searchParams.get("tab") ?? "documents")));
  },
  seed(store: Store): void {
    stateOf(store);
  },
};

export default xdsPlugin;
