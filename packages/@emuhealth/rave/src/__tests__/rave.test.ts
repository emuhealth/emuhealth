import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { parseXml, ravePlugin, seedFromConfig, XmlError, type RaveSeedConfig } from "../index.js";

const base = "http://localhost:4127";
const R = "/RaveWebServices";
const AUTH = `Basic ${Buffer.from("rws.synthetic:synthetic-password").toString("base64")}`;

function startService(config?: RaveSeedConfig) {
  const app = new Hono();
  const store = new Store();
  ravePlugin.register(app as never, store, new WebhookDispatcher(), base);
  ravePlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string, init: RequestInit = {}, auth = AUTH) => {
    const res = await app.request(`${base}${path}`, {
      ...init,
      headers: { Authorization: auth, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      headers: res.headers,
      xml: text.startsWith("<") ? parseXml(text) : undefined,
    };
  };
}

const find = (el: any, name: string): any[] => [
  ...(el.name.endsWith(name) ? [el] : []),
  ...el.children.flatMap((c: any) => find(c, name)),
];

const post = (subjects: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<ODM FileType="Transactional" FileOID="file-1" CreationDateTime="2026-02-01T10:00:00" ODMVersion="1.3"
  xmlns="http://www.cdisc.org/ns/odm/v1.3" xmlns:mdsol="http://www.mdsol.com/ns/odm/metadata">
  <ClinicalData StudyOID="EMU-101 (Prod)" MetaDataVersionOID="1001">${subjects}</ClinicalData>
</ODM>`;

describe("XML", () => {
  it("parses ODM with entities, comments, and CDATA", () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>t&lt;<![CDATA[<raw>]]></b><c/></a>');
    expect(root.attrs.x).toBe("1 & 2");
    expect(root.children[0].text).toBe("t<<raw>");
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
  });
});

describe("RWS", () => {
  it("serves version endpoints without credentials and requires them elsewhere", async () => {
    const req = startService();
    expect((await req(`${R}/version`, {}, "")).text).toBe("1.18.0");
    const denied = await req(`${R}/studies`, {}, `Basic ${Buffer.from("x:y").toString("base64")}`);
    expect(denied.status).toBe(401);
    expect(denied.xml!.attrs["mdsol:ErrorDescription"]).toContain("RWS00008");
  });

  it("lists studies, versions, and metadata", async () => {
    const req = startService();
    const list = await req(`${R}/studies`);
    expect(find(list.xml, "Study").map((s) => s.attrs.OID)).toEqual([
      "EMU-101",
      "EMU-101(UAT)",
      "EMU-202",
      "EMU-202(UAT)",
    ]);
    expect(find(list.xml, "StudyName").map((s) => s.text)).toContain("EMU-101 (UAT)");
    const versions = await req(`${R}/metadata/studies/EMU-101/versions`);
    expect(find(versions.xml, "MetaDataVersion")[0].attrs.OID).toBe("1001");
    const meta = await req(`${R}/metadata/studies/EMU-101/versions/1001`);
    expect(find(meta.xml, "FormDef").map((f) => f.attrs.OID)).toEqual(["DM", "VS", "AE"]);
    expect(find(meta.xml, "ItemDef").find((i) => i.attrs.OID === "VS.PULSE").attrs.DataType).toBe("integer");
    const missing = await req(`${R}/metadata/studies/EMU-101/versions/9`);
    expect(missing.status).toBe(404);
    expect(missing.xml!.attrs).toMatchObject({
      ReasonCode: "RWS00092",
      ErrorClientResponseMessage: "CRF version not found",
    });
  });

  it("lists subjects with status, links, and UUID keys", async () => {
    const req = startService();
    const res = await req(`${R}/studies/EMU-101(Prod)/subjects?status=all&links=all&subjectKeyType=SubjectUUID`);
    const subjects = find(res.xml, "SubjectData");
    expect(subjects).toHaveLength(8);
    expect(subjects[0].attrs).toMatchObject({
      "mdsol:SubjectKeyType": "SubjectUUID",
      "mdsol:SubjectName": "101-001",
      "mdsol:Touched": "Yes",
    });
    expect(find(res.xml, "Link")[0].attrs["xlink:href"]).toContain("SubjectPage.aspx?ID=1");
    expect(find((await req(`${R}/studies/EMU-101(UAT)/subjects`)).xml, "SubjectData")).toHaveLength(2);
    expect((await req(`${R}/studies/NOPE(Prod)/subjects`)).status).toBe(404);
  });

  it("returns clinical data datasets by study, subject, and form", async () => {
    const req = startService();
    const all = await req(`${R}/studies/EMU-101(Prod)/datasets/regular`);
    expect(find(all.xml, "ClinicalData")).toHaveLength(8);
    const vs = await req(`${R}/studies/EMU-101(Prod)/datasets/regular/AE`);
    expect(find(vs.xml, "FormData").every((f) => f.attrs.FormOID === "AE")).toBe(true);
    expect(find(vs.xml, "ItemGroupData").length).toBeGreaterThan(1);
    const one = await req(`${R}/studies/EMU-101(Prod)/subjects/101-001/datasets/raw`);
    expect(find(one.xml, "ItemData").find((i) => i.attrs.ItemOID === "DM.SEX").attrs.Value).toMatch(/^[MF]$/);
    expect((await req(`${R}/studies/EMU-101(Prod)/datasets/weird`)).status).toBe(400);
  });

  it("imports ODM clinical data transactionally and records audits", async () => {
    const req = startService();
    const ok = await req(`${R}/webservice.aspx?PostODMClinicalData`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: post(`
        <SubjectData SubjectKey="101-900" TransactionType="Insert">
          <SiteRef LocationOID="SYN-SITE-101" />
          <StudyEventData StudyEventOID="SCREENING">
            <FormData FormOID="VS" FormRepeatKey="1" TransactionType="Update">
              <ItemGroupData ItemGroupOID="VS" mdsol:Submission="SpecifiedItemsOnly">
                <ItemData ItemOID="VS.PULSE" Value="71" />
                <ItemData ItemOID="SYSBP" Value="118" />
              </ItemGroupData>
            </FormData>
          </StudyEventData>
        </SubjectData>`),
    });
    expect(ok.status).toBe(200);
    expect(ok.xml!.attrs).toMatchObject({
      IsTransactionSuccessful: "1",
      InboundODMFileOID: "file-1",
      SuccessStatistics: "Rave objects touched: Subjects=1; Folders=1; Forms=1; Fields=2; LogLines=0",
      SubjectNumberInStudy: "9",
    });
    const data = await req(`${R}/studies/EMU-101(Prod)/subjects/101-900/datasets/regular`);
    expect(find(data.xml, "ItemData").map((i) => [i.attrs.ItemOID, i.attrs.Value])).toEqual([
      ["VS.PULSE", "71"],
      ["VS.SYSBP", "118"],
    ]);

    const bad = await req(`${R}/webservice.aspx?PostODMClinicalData`, {
      method: "POST",
      body: post(`
        <SubjectData SubjectKey="101-901" TransactionType="Insert"><SiteRef LocationOID="SYN-SITE-101" /></SubjectData>
        <SubjectData SubjectKey="101-900" TransactionType="Update">
          <StudyEventData StudyEventOID="SCREENING"><FormData FormOID="VS"><ItemGroupData ItemGroupOID="VS">
            <ItemData ItemOID="VS.PULSE" Value="fast" />
          </ItemGroupData></FormData></StudyEventData>
        </SubjectData>`),
    });
    expect(bad.status).toBe(400);
    expect(bad.xml!.attrs).toMatchObject({ IsTransactionSuccessful: "0", ReasonCode: "EMU010" });
    expect(bad.text.startsWith("<Response")).toBe(true);
    const duplicate = await req(`${R}/webservice.aspx?PostODMClinicalData`, {
      method: "POST",
      body: post(
        `<SubjectData SubjectKey="101-900" TransactionType="Insert"><SiteRef LocationOID="SYN-SITE-101" /></SubjectData>`,
      ),
    });
    expect(duplicate.xml!.attrs).toMatchObject({
      ReasonCode: "RWS00024",
      ErrorOriginLocation: "/ODM/ClinicalData[1]/SubjectData[1]",
      ErrorClientResponseMessage: "Subject already exists.",
    });
    expect(bad.xml!.attrs.ErrorOriginLocation).toBe(
      "/ODM/ClinicalData[1]/SubjectData[2]/StudyEventData[1]/FormData[1]/ItemGroupData[1]/ItemData[1]",
    );
    const subjects = await req(`${R}/studies/EMU-101(Prod)/subjects`);
    expect(find(subjects.xml, "SubjectData").map((s) => s.attrs.SubjectKey)).not.toContain("101-901");

    const audits = await req(`${R}/datasets/ClinicalAuditRecords.odm?studyoid=EMU-101(Prod)&per_page=5`);
    expect(find(audits.xml, "AuditRecord")).toHaveLength(5);
    expect(audits.headers.get("link")).toMatch(/startid=6&per_page=5>; rel="next"/);
    const tail = await req(`${R}/datasets/ClinicalAuditRecords.odm?studyoid=EMU-101(Prod)&startid=1&per_page=10000`);
    const last = find(tail.xml, "ClinicalData").pop();
    expect(find(last, "ItemData")[0].attrs).toMatchObject({ ItemOID: "VS.SYSBP", Value: "118" });
    expect(find(last, "UserRef")[0].attrs.UserOID).toBe("rws.synthetic");
    expect(tail.headers.get("link")).toBeNull();
  });

  it("starts without subjects when generate is false", async () => {
    const req = startService({ generate: false, users: [{ username: "me", password: "pw" }] });
    const auth = `Basic ${Buffer.from("me:pw").toString("base64")}`;
    expect(find((await req(`${R}/studies/EMU-101(Prod)/subjects`, {}, auth)).xml, "SubjectData")).toHaveLength(0);
    expect((await req(`${R}/studies`)).status).toBe(401);
  });
});

describe("shared population", () => {
  it("makes EMU-101 Prod subjects the people of the FHIR population", async () => {
    const { syntheticPeople } = await import("@emuhealth/fhir-core");
    const { generateStudies } = await import("../index.js");
    const prod = generateStudies({ subjects: 3, population: { seed: 4 } }).find(
      (s) => s.project === "EMU-101" && s.env === "Prod",
    )!;
    const people = syntheticPeople({ patients: 3, seed: 4 });
    prod.subjects.forEach((subject, i) => {
      const dm = subject.events[0].forms.find((f) => f.formOid === "DM")!.groups[0].items;
      expect(dm["DM.BRTHDAT"]).toBe(people[i].birthDate);
      expect(dm["DM.SEX"]).toBe(people[i].gender === "male" ? "M" : people[i].gender === "female" ? "F" : "U");
    });
  });
});

describe("trial-adverse-event scenario", () => {
  it("logs a serious syncope for the linked subject", async () => {
    const { generateStudies } = await import("../index.js");
    const prod = generateStudies({ population: { scenarios: ["trial-adverse-event"] } }).find(
      (s) => s.project === "EMU-101" && s.env === "Prod",
    )!;
    const ae = (key: string) =>
      prod.subjects
        .find((s) => s.key === key)!
        .events.find((e) => e.eventOid === "LOGS")
        ?.forms[0].groups.map((g) => g.items["AE.AETERM"]);
    // syn-patient-003 is subject index 2, the first subject of the third site.
    expect(ae(prod.subjects[2].key)).toEqual(["Syncope"]);
    expect(prod.subjects[2].events.find((e) => e.eventOid === "LOGS")!.forms[0].groups[0].items["AE.AESER"]).toBe("Y");
    expect(ae(prod.subjects[1].key)).toEqual(["Headache", "Nausea"]);
  });
});
