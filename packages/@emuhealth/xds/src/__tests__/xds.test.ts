import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { syntheticPeople } from "@emuhealth/fhir-core";
import { ACTIONS, HOME_COMMUNITY_ID, parseXml, patientCx, QUERIES, REPOSITORY_ID, xdsPlugin } from "../index.js";

const base = "http://localhost:4130";
const NS = `xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"`;
const RIM = "urn:oasis:names:tc:ebxml-regrep:xsd:rim:3.0";
const UNIQUE_ID = "urn:uuid:2e82c1f6-a085-4c72-9da3-8640a32e42ab";

function start() {
  const app = new Hono();
  const store = new Store();
  xdsPlugin.register(app as never, store, new WebhookDispatcher(), base);
  xdsPlugin.seed?.(store, base);
  return async (path: string, action: string, body: string, mtom?: { attachments: Record<string, Buffer> }) => {
    const envelope = `<s:Envelope ${NS}><s:Header><a:Action>${action}</a:Action><a:MessageID>urn:uuid:test-1</a:MessageID></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    let payload: Buffer | string = envelope;
    let contentType = `application/soap+xml; charset=UTF-8; action="${action}"`;
    if (mtom) {
      const boundary = "MIMEtest";
      const parts: Buffer[] = [
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/xop+xml; type="application/soap+xml"\r\nContent-ID: <root@test>\r\n\r\n${envelope}\r\n`,
        ),
      ];
      for (const [id, data] of Object.entries(mtom.attachments))
        parts.push(
          Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${id}>\r\n\r\n`),
          data,
          Buffer.from("\r\n"),
        );
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      payload = Buffer.concat(parts);
      contentType = `multipart/related; boundary="${boundary}"; type="application/xop+xml"; start="<root@test>"; start-info="application/soap+xml"`;
    }
    const res = await app.request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: payload,
    });
    const raw = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", raw, text: raw.toString("utf8") };
  };
}

type Node = ReturnType<typeof parseXml>;
const bodyOf = (text: string): Node => {
  const env = parseXml(text.slice(text.indexOf("<s:Envelope"), text.lastIndexOf("</s:Envelope>") + 13));
  return env.children.find((c) => c.name.endsWith("Body"))!.children[0];
};
const all = (node: Node, name: string): Node[] => [
  ...(node.name.endsWith(`:${name}`) || node.name === name ? [node] : []),
  ...node.children.flatMap((c) => all(c, name)),
];
const uniqueIdOf = (obj: Node) =>
  all(obj, "ExternalIdentifier").find((e) => e.attrs.identificationScheme === UNIQUE_ID)!.attrs.value;

const person = syntheticPeople()[0];
const PID = patientCx(person.mrn);

const findDocuments = (patient: string, returnType = "LeafClass", home?: string) =>
  `<query:AdhocQueryRequest xmlns:query="urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0" xmlns:rim="${RIM}">
    <query:ResponseOption returnComposedObjects="true" returnType="${returnType}"/>
    <rim:AdhocQuery id="${QUERIES.findDocuments}"${home ? ` home="${home}"` : ""}>
      <rim:Slot name="$XDSDocumentEntryPatientId"><rim:ValueList><rim:Value>'${patient}'</rim:Value></rim:ValueList></rim:Slot>
      <rim:Slot name="$XDSDocumentEntryStatus"><rim:ValueList><rim:Value>('urn:oasis:names:tc:ebxml-regrep:StatusType:Approved')</rim:Value></rim:ValueList></rim:Slot>
    </rim:AdhocQuery>
  </query:AdhocQueryRequest>`;

const retrieveRequest = (uniqueId: string, home?: string) =>
  `<xdsb:RetrieveDocumentSetRequest xmlns:xdsb="urn:ihe:iti:xds-b:2007"><xdsb:DocumentRequest>${
    home ? `<xdsb:HomeCommunityId>${home}</xdsb:HomeCommunityId>` : ""
  }<xdsb:RepositoryUniqueId>${REPOSITORY_ID}</xdsb:RepositoryUniqueId><xdsb:DocumentUniqueId>${uniqueId}</xdsb:DocumentUniqueId></xdsb:DocumentRequest></xdsb:RetrieveDocumentSetRequest>`;

let n = 0;
const cls = (scheme: string, obj: string, code: string, codingScheme: string) =>
  `<rim:Classification classificationScheme="${scheme}" classifiedObject="${obj}" id="cl-${n++}" nodeRepresentation="${code}"><rim:Slot name="codingScheme"><rim:ValueList><rim:Value>${codingScheme}</rim:Value></rim:ValueList></rim:Slot><rim:Name><rim:LocalizedString value="${code}"/></rim:Name></rim:Classification>`;

function provideAndRegister(patient: string, uniqueId: string, document: string) {
  const doc = "Document01";
  return `<xdsb:ProvideAndRegisterDocumentSetRequest xmlns:xdsb="urn:ihe:iti:xds-b:2007" xmlns:lcm="urn:oasis:names:tc:ebxml-regrep:xsd:lcm:3.0" xmlns:rim="${RIM}" xmlns:xop="http://www.w3.org/2004/08/xop/include">
    <lcm:SubmitObjectsRequest><rim:RegistryObjectList>
      <rim:ExtrinsicObject id="${doc}" mimeType="text/plain" objectType="urn:uuid:7edca82f-054d-47f2-a032-9b2a5b5186c1">
        <rim:Slot name="creationTime"><rim:ValueList><rim:Value>20260201120000</rim:Value></rim:ValueList></rim:Slot>
        <rim:Name><rim:LocalizedString value="Submitted note"/></rim:Name>
        ${cls("urn:uuid:41a5887f-8865-4c09-adf7-e362475b143a", doc, "11506-3", "2.16.840.1.113883.6.1")}
        ${cls("urn:uuid:f4f85eac-e6cb-4883-b524-f2705394840f", doc, "N", "2.16.840.1.113883.5.25")}
        ${cls("urn:uuid:a09d5840-386c-46f2-b5ad-9c3699a4309d", doc, "urn:ihe:iti:xds:2017:mimeTypeSufficient", "1.3.6.1.4.1.19376.1.2.3")}
        ${cls("urn:uuid:f33fb8ac-18af-42cc-ae0e-ed0b0bdb91e1", doc, "OF", "2.16.840.1.113883.5.111")}
        ${cls("urn:uuid:cccf5598-8b07-4b77-a05e-ae952c785ead", doc, "general-medicine", "2.25.1")}
        ${cls("urn:uuid:f0306f51-975f-434e-a61c-c59651d33983", doc, "11506-3", "2.16.840.1.113883.6.1")}
        <rim:ExternalIdentifier id="ei1" identificationScheme="urn:uuid:58a6f841-87b3-4a3e-92fd-a8ffeff98427" registryObject="${doc}" value="${patient}"><rim:Name><rim:LocalizedString value="XDSDocumentEntry.patientId"/></rim:Name></rim:ExternalIdentifier>
        <rim:ExternalIdentifier id="ei2" identificationScheme="${UNIQUE_ID}" registryObject="${doc}" value="${uniqueId}"><rim:Name><rim:LocalizedString value="XDSDocumentEntry.uniqueId"/></rim:Name></rim:ExternalIdentifier>
      </rim:ExtrinsicObject>
      <rim:RegistryPackage id="SubmissionSet01">
        <rim:Slot name="submissionTime"><rim:ValueList><rim:Value>20260201120000</rim:Value></rim:ValueList></rim:Slot>
        <rim:ExternalIdentifier id="ei3" identificationScheme="urn:uuid:96fdda7c-d067-4183-912e-bf5ee74998a8" registryObject="SubmissionSet01" value="${uniqueId}.9"/>
        <rim:ExternalIdentifier id="ei4" identificationScheme="urn:uuid:554ac39e-e3fe-47fe-b233-965d2a147832" registryObject="SubmissionSet01" value="2.25.9"/>
        <rim:ExternalIdentifier id="ei5" identificationScheme="urn:uuid:6b5aea1a-874d-4603-a4bc-96a0a7b38446" registryObject="SubmissionSet01" value="${patient}"/>
      </rim:RegistryPackage>
    </rim:RegistryObjectList></lcm:SubmitObjectsRequest>
    <xdsb:Document id="${doc}">${document}</xdsb:Document>
  </xdsb:ProvideAndRegisterDocumentSetRequest>`;
}

describe("XDS.b and XCA", () => {
  it("finds and retrieves the synthetic documents", async () => {
    const soap = start();
    const leaf = await soap("/xds/registry", ACTIONS.storedQuery, findDocuments(PID));
    expect(leaf.status).toBe(200);
    expect(leaf.contentType).toContain('action="urn:ihe:iti:2007:RegistryStoredQueryResponse"');
    expect(leaf.text).toContain("<a:RelatesTo>urn:uuid:test-1</a:RelatesTo>");
    const objects = all(bodyOf(leaf.text), "ExtrinsicObject");
    expect(objects).toHaveLength(2);
    const uniqueId = uniqueIdOf(objects[0]);

    const refs = await soap("/xds/registry", ACTIONS.storedQuery, findDocuments(PID, "ObjectRef"));
    expect(all(bodyOf(refs.text), "ObjectRef")).toHaveLength(2);

    const sets = await soap(
      "/xds/registry",
      ACTIONS.storedQuery,
      `<query:AdhocQueryRequest xmlns:query="urn:oasis:names:tc:ebxml-regrep:xsd:query:3.0" xmlns:rim="${RIM}"><query:ResponseOption returnType="LeafClass"/><rim:AdhocQuery id="${QUERIES.getSubmissionSets}"><rim:Slot name="$uuid"><rim:ValueList><rim:Value>('${objects[0].attrs.id}')</rim:Value></rim:ValueList></rim:Slot></rim:AdhocQuery></query:AdhocQueryRequest>`,
    );
    expect(all(bodyOf(sets.text), "RegistryPackage")).toHaveLength(1);
    expect(all(bodyOf(sets.text), "Association")[0].attrs.targetObject).toBe(objects[0].attrs.id);

    const got = await soap("/xds/repository", ACTIONS.retrieve, retrieveRequest(uniqueId));
    const doc = all(bodyOf(got.text), "Document")[0];
    expect(Buffer.from(doc.text, "base64").toString()).toContain(person.family);
    const missing = await soap("/xds/repository", ACTIONS.retrieve, retrieveRequest("2.25.0"));
    expect(missing.text).toContain("XDSDocumentUniqueIdError");
  });

  it("stores an MTOM provide and register and returns MTOM on retrieve", async () => {
    const soap = start();
    const content = Buffer.from("Synthetic attachment note");
    const stored = await soap(
      "/xds/repository",
      ACTIONS.provideAndRegister,
      provideAndRegister(PID, "2.25.777.1", '<xop:Include href="cid:doc1@test"/>'),
      { attachments: { "doc1@test": content } },
    );
    expect(stored.text).toContain("ResponseStatusType:Success");
    const again = await soap(
      "/xds/repository",
      ACTIONS.provideAndRegister,
      provideAndRegister(PID, "2.25.777.1", content.toString("base64")),
    );
    expect(again.text).toContain("XDSDuplicateUniqueIdInRegistry");
    const unknown = await soap(
      "/xds/repository",
      ACTIONS.provideAndRegister,
      provideAndRegister("X^^^&2.25.1&ISO", "2.25.777.2", content.toString("base64")),
    );
    expect(unknown.text).toContain("XDSUnknownPatientId");

    const mtom = await soap("/xds/repository", ACTIONS.retrieve, retrieveRequest("2.25.777.1"), { attachments: {} });
    expect(mtom.contentType).toMatch(/^multipart\/related/);
    expect(mtom.text).toContain("<xop:Include");
    expect(mtom.raw.includes(content)).toBe(true);
  });

  it("answers XCA cross gateway queries with the home community", async () => {
    const soap = start();
    const res = await soap("/xca/query", ACTIONS.crossGatewayQuery, findDocuments(PID, "LeafClass", HOME_COMMUNITY_ID));
    const objects = all(bodyOf(res.text), "ExtrinsicObject");
    expect(objects[0].attrs.home).toBe(HOME_COMMUNITY_ID);
    const got = await soap(
      "/xca/retrieve",
      ACTIONS.crossGatewayRetrieve,
      retrieveRequest(uniqueIdOf(objects[0]), HOME_COMMUNITY_ID),
    );
    expect(got.text).toContain(`<xdsb:HomeCommunityId>${HOME_COMMUNITY_ID}</xdsb:HomeCommunityId>`);
    const wrong = await soap(
      "/xca/query",
      ACTIONS.crossGatewayQuery,
      findDocuments(PID, "LeafClass", "urn:oid:2.25.1"),
    );
    expect(wrong.text).toContain("XDSUnknownCommunity");
  });

  it("reports query and SOAP errors", async () => {
    const soap = start();
    const noPatient = await soap(
      "/xds/registry",
      ACTIONS.storedQuery,
      findDocuments("").replace(/<rim:Slot name="\$XDSDocumentEntryPatientId">.*?<\/rim:Slot>/s, ""),
    );
    expect(noPatient.text).toContain("XDSStoredQueryParamNumber");
    const fault = await soap("/xds/registry", "urn:example:nope", "<x/>");
    expect(fault.status).toBe(400);
    expect(fault.text).toContain("s:Sender");
  });
});
