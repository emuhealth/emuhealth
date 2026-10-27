import { createHash, randomUUID } from "node:crypto";
import { childrenNamed, el, local, textEl, type XmlElement } from "./xml.js";

// XDS metadata in ebRIM 3.0: DocumentEntries (ExtrinsicObject), SubmissionSets (RegistryPackage), their
// classifications and external identifiers, as defined in IHE ITI TF-3.

export const NS = {
  rim: "urn:oasis:names:tc:ebxml-regrep:xsd:rim:3.0",
  rs: "urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0",
  lcm: "urn:oasis:names:tc:ebxml-regrep:xsd:lcm:3.0",
  query: "urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0",
  xdsb: "urn:ihe:iti:xds-b:2007",
};

export const STATUS_APPROVED = "urn:oasis:names:tc:ebxml-regrep:StatusType:Approved";
export const STATUS_DEPRECATED = "urn:oasis:names:tc:ebxml-regrep:StatusType:Deprecated";
const DOCUMENT_ENTRY = "urn:uuid:7edca82f-054d-47f2-a032-9b2a5b5186c1";
const SUBMISSION_SET = "urn:uuid:a54d6aa5-d40d-43f9-88c5-b4633d873bdd";
const CLASSIFICATION = "urn:oasis:names:tc:ebxml-regrep:ObjectType:RegistryObject:Classification";
const EXTERNAL_ID = "urn:oasis:names:tc:ebxml-regrep:ObjectType:RegistryObject:ExternalIdentifier";

export const SCHEMES = {
  classCode: "urn:uuid:41a5887f-8865-4c09-adf7-e362475b143a",
  confidentialityCode: "urn:uuid:f4f85eac-e6cb-4883-b524-f2705394840f",
  formatCode: "urn:uuid:a09d5840-386c-46f2-b5ad-9c3699a4309d",
  healthcareFacilityTypeCode: "urn:uuid:f33fb8ac-18af-42cc-ae0e-ed0b0bdb91e1",
  practiceSettingCode: "urn:uuid:cccf5598-8b07-4b77-a05e-ae952c785ead",
  typeCode: "urn:uuid:f0306f51-975f-434e-a61c-c59651d33983",
} as const;
const PATIENT_ID = "urn:uuid:58a6f841-87b3-4a3e-92fd-a8ffeff98427";
const UNIQUE_ID = "urn:uuid:2e82c1f6-a085-4c72-9da3-8640a32e42ab";
const SET_PATIENT_ID = "urn:uuid:6b5aea1a-874d-4603-a4bc-96a0a7b38446";
const SET_UNIQUE_ID = "urn:uuid:96fdda7c-d067-4183-912e-bf5ee74998a8";
const SET_SOURCE_ID = "urn:uuid:554ac39e-e3fe-47fe-b233-965d2a147832";

export type CodeName = keyof typeof SCHEMES;
export interface Code {
  code: string;
  scheme: string;
  display: string;
}

export interface DocumentEntry {
  entryUUID: string;
  uniqueId: string;
  patientId: string;
  status: typeof STATUS_APPROVED | typeof STATUS_DEPRECATED;
  mimeType: string;
  title: string;
  creationTime: string;
  languageCode: string;
  codes: Record<CodeName, Code>;
  repositoryUniqueId: string;
  size: number;
  hash: string;
  submissionSet: string;
  content: Buffer;
}

export interface Submission {
  entryUUID: string;
  uniqueId: string;
  sourceId: string;
  patientId: string;
  submissionTime: string;
  documents: string[];
}

export const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("hex");

// Parsing ITI-41 and ITI-42 SubmitObjectsRequest.

const slot = (obj: XmlElement, name: string) =>
  childrenNamed(obj, "Slot")
    .find((s) => s.attrs.name === name)
    ?.children.flatMap((list) => list.children.map((v) => v.text.trim())) ?? [];
const nameOf = (obj: XmlElement) => {
  const name = childrenNamed(obj, "Name")[0];
  return (name && childrenNamed(name, "LocalizedString")[0]?.attrs.value) ?? "";
};
const external = (obj: XmlElement, scheme: string) =>
  childrenNamed(obj, "ExternalIdentifier").find((x) => x.attrs.identificationScheme === scheme)?.attrs.value;

export interface ParsedSubmission {
  documents: Array<
    Omit<DocumentEntry, "content" | "size" | "hash" | "repositoryUniqueId" | "submissionSet"> & {
      symbolicId: string;
      size?: number;
      hash?: string;
    }
  >;
  submission?: Omit<Submission, "documents">;
}

export class XdsError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly location?: string,
  ) {
    super(message);
  }
}

export function parseSubmitObjects(request: XmlElement): ParsedSubmission {
  const list = request.children.find((c) => local(c.name) === "RegistryObjectList");
  if (!list) throw new XdsError("XDSRegistryMetadataError", "SubmitObjectsRequest has no RegistryObjectList");
  const documents: ParsedSubmission["documents"] = [];
  for (const obj of childrenNamed(list, "ExtrinsicObject")) {
    const symbolicId = obj.attrs.id;
    const patientId = external(obj, PATIENT_ID);
    const uniqueId = external(obj, UNIQUE_ID);
    if (!patientId || !uniqueId)
      throw new XdsError(
        "XDSRegistryMetadataError",
        `DocumentEntry ${symbolicId} needs a patientId and a uniqueId`,
        symbolicId,
      );
    const codes = {} as Record<CodeName, Code>;
    for (const [name, scheme] of Object.entries(SCHEMES) as Array<[CodeName, string]>) {
      const c = childrenNamed(obj, "Classification").find((x) => x.attrs.classificationScheme === scheme);
      if (!c) throw new XdsError("XDSRegistryMetadataError", `DocumentEntry ${symbolicId} has no ${name}`, symbolicId);
      codes[name] = {
        code: c.attrs.nodeRepresentation ?? "",
        scheme: slot(c, "codingScheme")[0] ?? "",
        display: nameOf(c),
      };
    }
    const size = slot(obj, "size")[0];
    const hash = slot(obj, "hash")[0];
    documents.push({
      symbolicId,
      entryUUID: symbolicId.startsWith("urn:uuid:") ? symbolicId : `urn:uuid:${randomUUID()}`,
      uniqueId,
      patientId,
      status: STATUS_APPROVED,
      mimeType: obj.attrs.mimeType ?? "application/octet-stream",
      title: nameOf(obj),
      creationTime: slot(obj, "creationTime")[0] ?? "",
      languageCode: slot(obj, "languageCode")[0] ?? "en-US",
      codes,
      ...(size ? { size: Number(size) } : {}),
      ...(hash ? { hash: hash.toLowerCase() } : {}),
    });
  }
  const pkg = childrenNamed(list, "RegistryPackage")[0];
  const submission = pkg
    ? {
        entryUUID: pkg.attrs.id?.startsWith("urn:uuid:") ? pkg.attrs.id : `urn:uuid:${randomUUID()}`,
        uniqueId: external(pkg, SET_UNIQUE_ID) ?? "",
        sourceId: external(pkg, SET_SOURCE_ID) ?? "",
        patientId: external(pkg, SET_PATIENT_ID) ?? "",
        submissionTime: slot(pkg, "submissionTime")[0] ?? "",
      }
    : undefined;
  if (!submission) throw new XdsError("XDSRegistryMetadataError", "The submission has no SubmissionSet");
  return { documents, submission };
}

// Building registry objects for query responses.

const slotEl = (name: string, ...values: string[]) =>
  el("rim:Slot", { name }, el("rim:ValueList", {}, ...values.map((v) => textEl("rim:Value", v))));
const nameEl = (value: string) => el("rim:Name", {}, el("rim:LocalizedString", { value }));

function classification(scheme: string, object: string, code: Code): string {
  return el(
    "rim:Classification",
    {
      classificationScheme: scheme,
      classifiedObject: object,
      id: `urn:uuid:${randomUUID()}`,
      nodeRepresentation: code.code,
      objectType: CLASSIFICATION,
    },
    slotEl("codingScheme", code.scheme),
    nameEl(code.display),
  );
}

function externalId(scheme: string, object: string, value: string, name: string): string {
  return el(
    "rim:ExternalIdentifier",
    {
      id: `urn:uuid:${randomUUID()}`,
      identificationScheme: scheme,
      objectType: EXTERNAL_ID,
      registryObject: object,
      value,
    },
    nameEl(name),
  );
}

export function extrinsicObject(doc: DocumentEntry, home?: string): string {
  return el(
    "rim:ExtrinsicObject",
    {
      id: doc.entryUUID,
      lid: doc.entryUUID,
      mimeType: doc.mimeType,
      objectType: DOCUMENT_ENTRY,
      status: doc.status,
      home,
    },
    slotEl("creationTime", doc.creationTime),
    slotEl("languageCode", doc.languageCode),
    slotEl("sourcePatientId", doc.patientId),
    slotEl("repositoryUniqueId", doc.repositoryUniqueId),
    slotEl("size", String(doc.size)),
    slotEl("hash", doc.hash),
    nameEl(doc.title),
    ...(Object.entries(SCHEMES) as Array<[CodeName, string]>).map(([name, scheme]) =>
      classification(scheme, doc.entryUUID, doc.codes[name]),
    ),
    externalId(PATIENT_ID, doc.entryUUID, doc.patientId, "XDSDocumentEntry.patientId"),
    externalId(UNIQUE_ID, doc.entryUUID, doc.uniqueId, "XDSDocumentEntry.uniqueId"),
  );
}

export function registryPackage(set: Submission, home?: string): string {
  return el(
    "rim:RegistryPackage",
    {
      id: set.entryUUID,
      lid: set.entryUUID,
      objectType: "urn:oasis:names:tc:ebxml-regrep:ObjectType:RegistryObject:RegistryPackage",
      status: STATUS_APPROVED,
      home,
    },
    slotEl("submissionTime", set.submissionTime),
    nameEl("Synthetic submission"),
    el("rim:Classification", {
      classificationNode: SUBMISSION_SET,
      classifiedObject: set.entryUUID,
      id: `urn:uuid:${randomUUID()}`,
      objectType: CLASSIFICATION,
    }),
    externalId(SET_UNIQUE_ID, set.entryUUID, set.uniqueId, "XDSSubmissionSet.uniqueId"),
    externalId(SET_SOURCE_ID, set.entryUUID, set.sourceId, "XDSSubmissionSet.sourceId"),
    externalId(SET_PATIENT_ID, set.entryUUID, set.patientId, "XDSSubmissionSet.patientId"),
  );
}

export function registryResponse(errors: XdsError[] = [], ...children: string[]): string {
  const status = errors.length
    ? "urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Failure"
    : "urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Success";
  return el(
    "rs:RegistryResponse",
    { "xmlns:rs": NS.rs, "xmlns:rim": NS.rim, status },
    errors.length ? registryErrorList(errors) : undefined,
    ...children,
  );
}

export function registryErrorList(errors: XdsError[]): string {
  return el(
    "rs:RegistryErrorList",
    { highestSeverity: "urn:oasis:names:tc:ebxml-regrep:ErrorSeverityType:Error" },
    ...errors.map((e) =>
      el("rs:RegistryError", {
        codeContext: e.message,
        errorCode: e.errorCode,
        severity: "urn:oasis:names:tc:ebxml-regrep:ErrorSeverityType:Error",
        location: e.location,
      }),
    ),
  );
}
