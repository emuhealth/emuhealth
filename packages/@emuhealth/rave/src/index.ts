import { randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderCardPage, renderInspectorPage } from "@emulators/core";
import {
  CODE_LISTS,
  EVENTS,
  FORMS,
  eventDef,
  formDef,
  generateStudies,
  stableUuid,
  type Audit,
  type GenerateOptions,
  type StudyEnv,
  type Subject,
} from "./design.js";
import { XmlError, childrenNamed, el, local, parseXml, textEl, type XmlElement } from "./xml.js";

export { generateStudies, FORMS, EVENTS, type GenerateOptions } from "./design.js";
export { parseXml, XmlError } from "./xml.js";

/** Medidata Rave Web Services (RWS) emulator: studies, subjects, ODM clinical data, metadata, and data import. */
export interface RaveSeedConfig {
  port?: number;
  /** RWS users for HTTP Basic authentication. */
  users?: Array<{ username: string; password: string }>;
  /** Synthetic studies and subjects; false starts with studies but no subjects. */
  generate?: GenerateOptions | false;
}

const KEY = { studies: "rave.studies", users: "rave.users" };
const SERVICE_LABEL = "Medidata Rave";
const RWS_VERSION = "1.18.0";
export const DEFAULT_USER = { username: "rws.synthetic", password: "synthetic-password" };
const NS = {
  xmlns: "http://www.cdisc.org/ns/odm/v1.3",
  "xmlns:mdsol": "http://www.mdsol.com/ns/odm/metadata",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};

const studies = (store: Store) => {
  let list = store.getData<StudyEnv[]>(KEY.studies);
  if (!list) {
    list = generateStudies();
    store.setData(KEY.studies, list);
  }
  return list;
};
const users = (store: Store) =>
  store.getData<Array<{ username: string; password: string }>>(KEY.users) ?? [DEFAULT_USER];

export function seedFromConfig(store: Store, _baseUrl: string, config: RaveSeedConfig): void {
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("rave.generate must be an object of generator options or false");
    store.setData(KEY.studies, generateStudies(config.generate === false ? { subjects: 0 } : config.generate));
  }
  if (config.users !== undefined) {
    if (!Array.isArray(config.users)) throw new Error("rave.users must be an array");
    for (const [i, u] of config.users.entries())
      if (typeof u?.username !== "string" || typeof u.password !== "string")
        throw new Error(`rave.users[${i}] needs username and password`);
    store.setData(KEY.users, config.users);
  }
}

// ODM output

const now = () => new Date().toISOString().replace(/Z$/, "");
const studyOid = (s: StudyEnv) => `${s.project}(${s.env})`;

function odm(attrs: Record<string, string | undefined>, ...children: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n${el(
    "ODM",
    { FileType: "Snapshot", FileOID: randomUUID(), CreationDateTime: now(), ODMVersion: "1.3", ...attrs, ...NS },
    ...children,
  )}`;
}

function studyListItem(oid: string, name: string, protocol: string, type?: string): string {
  return el(
    "Study",
    { OID: oid, "mdsol:ProjectType": type },
    el(
      "GlobalVariables",
      {},
      textEl("StudyName", name),
      textEl("StudyDescription", ""),
      textEl("ProtocolName", protocol),
    ),
  );
}

function metadataVersion(s: StudyEnv): string {
  const protocol = el(
    "Protocol",
    {},
    ...EVENTS.map((e, i) => el("StudyEventRef", { StudyEventOID: e.oid, OrderNumber: i + 1, Mandatory: "Yes" })),
  );
  const events = EVENTS.map((e) =>
    el(
      "StudyEventDef",
      { OID: e.oid, Name: e.name, Repeating: "No", Type: "Common" },
      ...e.forms.map((f, i) => el("FormRef", { FormOID: f, OrderNumber: i + 1, Mandatory: "No" })),
    ),
  );
  const forms = FORMS.map((f) =>
    el(
      "FormDef",
      { OID: f.oid, Name: f.name, Repeating: f.repeating ? "Yes" : "No" },
      el("ItemGroupRef", { ItemGroupOID: f.oid, Mandatory: "No" }),
    ),
  );
  const groups = FORMS.map((f) =>
    el(
      "ItemGroupDef",
      { OID: f.oid, Name: f.oid, Repeating: f.repeating ? "Yes" : "No" },
      ...f.items.map((it, i) => el("ItemRef", { ItemOID: it.oid, OrderNumber: i + 1, Mandatory: "No" })),
    ),
  );
  const items = FORMS.flatMap((f) =>
    f.items.map((it) =>
      el(
        "ItemDef",
        {
          OID: it.oid,
          Name: it.name,
          DataType: it.dataType,
          Length: it.length,
          "mdsol:DateTimeFormat": it.dataType === "date" ? "yyyy-MM-dd" : undefined,
        },
        el("Question", {}, el("TranslatedText", { "xml:lang": "en" }, escapeHtml(it.label))),
        it.codeList ? el("CodeListRef", { CodeListOID: it.codeList }) : undefined,
      ),
    ),
  );
  const codeLists = Object.entries(CODE_LISTS).map(([oid, values]) =>
    el(
      "CodeList",
      { OID: oid, Name: oid, DataType: "text" },
      ...values.map(([code, label]) =>
        el(
          "CodeListItem",
          { CodedValue: code },
          el("Decode", {}, el("TranslatedText", { "xml:lang": "en" }, escapeHtml(label))),
        ),
      ),
    ),
  );
  return el(
    "MetaDataVersion",
    { OID: s.versionOid, Name: `${s.project} CRF v1`, "mdsol:PrimaryFormOID": "DM" },
    protocol,
    ...events,
    ...forms,
    ...groups,
    ...items,
    ...codeLists,
  );
}

function subjectData(s: StudyEnv, subject: Subject, formOid?: string, start?: string): string | undefined {
  const site = s.sites.find((x) => x.oid === subject.site);
  const events = subject.events
    .map((e) => {
      const forms = e.forms
        .filter((f) => (!formOid || f.formOid === formOid) && (!start || f.modified >= start))
        .map((f) =>
          el(
            "FormData",
            { FormOID: f.formOid, FormRepeatKey: f.repeatKey },
            ...f.groups.map((g) =>
              el(
                "ItemGroupData",
                { ItemGroupOID: f.formOid, ItemGroupRepeatKey: g.repeatKey },
                ...Object.entries(g.items).map(([oid, value]) => el("ItemData", { ItemOID: oid, Value: value })),
              ),
            ),
          ),
        );
      return forms.length
        ? el("StudyEventData", { StudyEventOID: e.eventOid, StudyEventRepeatKey: e.repeatKey }, ...forms)
        : "";
    })
    .filter(Boolean);
  if ((formOid || start) && !events.length) return undefined;
  return el(
    "ClinicalData",
    { StudyOID: studyOid(s), MetaDataVersionOID: s.versionOid },
    el(
      "SubjectData",
      { SubjectKey: subject.key, "mdsol:SubjectKeyType": "SubjectName" },
      el("SiteRef", { LocationOID: subject.site, "mdsol:StudyEnvSiteNumber": site?.number }),
      ...events,
    ),
  );
}

// Errors

function rwsError(c: Context<AppEnv>, status: 400 | 401 | 404 | 405, message: string) {
  return c.body(odm({ "mdsol:ErrorDescription": message }), status, { "Content-Type": "text/xml; charset=utf-8" });
}

// RWS sends Response documents without an XML declaration, and rwslib relies on that to recognize them.
function postError(c: Context<AppEnv>, fileOid: string, location: string, code: string, message: string) {
  return c.body(
    `${el("Response", {
      ReferenceNumber: randomUUID(),
      InboundODMFileOID: fileOid,
      IsTransactionSuccessful: "0",
      ReasonCode: code,
      ErrorOriginLocation: location,
      SuccessStatistics: "Rave objects touched: Subjects=0; Folders=0; Forms=0; Fields=0; LogLines=0",
      ErrorClientResponseMessage: message,
    })}`,
    409,
    { "Content-Type": "text/xml; charset=utf-8" },
  );
}

class PostError extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
    message: string,
  ) {
    super(message);
  }
}

function findStudy(store: Store, text: string): StudyEnv | undefined {
  const m = /^(.+?)\s*\((.+)\)$/.exec(text.trim());
  const project = m ? m[1] : text.trim();
  const env = m ? m[2] : "Prod";
  return studies(store).find((s) => s.project === project && s.env.toLowerCase() === env.toLowerCase());
}

const DATE = /^\d{4}-\d{2}-\d{2}$|^\d{2} [A-Za-z]{3} \d{4}$/;

/** Apply an ODM ClinicalData import. Changes go to copies and are committed only when every element applies. */
function applyImport(store: Store, root: XmlElement, user: string) {
  if (local(root.name) !== "ODM") throw new PostError("EMU001", "/ODM", "The document root must be an ODM element");
  const stats = { Subjects: 0, Folders: 0, Forms: 0, Fields: 0, LogLines: 0 };
  const changed = new Map<StudyEnv, { subjects: Subject[]; audits: Audit[] }>();
  let subjectNumbers: { study: number; site: number } | undefined;
  const clinical = childrenNamed(root, "ClinicalData");
  if (!clinical.length) throw new PostError("EMU001", "/ODM", "The ODM document has no ClinicalData");
  clinical.forEach((cd, ci) => {
    const where = `/ODM/ClinicalData[${ci + 1}]`;
    const study = findStudy(store, cd.attrs.StudyOID ?? "");
    if (!study) throw new PostError("EMU011", where, `Study ${cd.attrs.StudyOID ?? ""} not found`);
    let working = changed.get(study);
    if (!working) {
      working = { subjects: structuredClone(study.subjects), audits: [...study.audits] };
      changed.set(study, working);
    }
    const w = working;
    childrenNamed(cd, "SubjectData").forEach((sd, si) => {
      const swhere = `${where}/SubjectData[${si + 1}]`;
      const key = sd.attrs.SubjectKey ?? "";
      if (!key) throw new PostError("EMU002", swhere, "SubjectKey is required");
      const byUuid = sd.attrs["mdsol:SubjectKeyType"] === "SubjectUUID";
      const tx = sd.attrs.TransactionType ?? "Context";
      let subject = w.subjects.find((x) => (byUuid ? x.uuid === key : x.key === key) && !x.deleted);
      if (tx === "Insert" && subject) throw new PostError("EMU003", swhere, `Subject ${key} already exists`);
      if (!subject && (tx === "Insert" || tx === "Upsert")) {
        if (byUuid) throw new PostError("EMU002", swhere, "New subjects need a SubjectKey of type SubjectName");
        const siteOid = childrenNamed(sd, "SiteRef")[0]?.attrs.LocationOID;
        const site = study.sites.find((s) => s.oid === siteOid);
        if (!site) throw new PostError("EMU004", swhere, `Site ${siteOid ?? "(none)"} not found in ${studyOid(study)}`);
        subject = {
          key,
          uuid: stableUuid(`${studyOid(study)}|${key}|${randomUUID()}`),
          site: site.oid,
          number: w.subjects.length + 1,
          active: true,
          deleted: false,
          events: [],
        };
        w.subjects.push(subject);
        stats.Subjects++;
        subjectNumbers = {
          study: w.subjects.filter((x) => !x.deleted).length,
          site: w.subjects.filter((x) => !x.deleted && x.site === site.oid).length,
        };
      }
      if (!subject) throw new PostError("EMU005", swhere, `Subject ${key} not found in ${studyOid(study)}`);
      if (tx === "Remove") {
        subject.deleted = true;
        stats.Subjects++;
        return;
      }
      const target = subject;
      childrenNamed(sd, "StudyEventData").forEach((ed, ei) => {
        const ewhere = `${swhere}/StudyEventData[${ei + 1}]`;
        const def = eventDef(ed.attrs.StudyEventOID ?? "");
        if (!def) throw new PostError("EMU006", ewhere, `Folder ${ed.attrs.StudyEventOID ?? ""} not found`);
        const repeatKey = ed.attrs.StudyEventRepeatKey ?? "1";
        let event = target.events.find((e) => e.eventOid === def.oid && e.repeatKey === repeatKey);
        if (!event) {
          event = { eventOid: def.oid, repeatKey, forms: [] };
          target.events.push(event);
          stats.Folders++;
        }
        const evt = event;
        childrenNamed(ed, "FormData").forEach((fd, fi) => {
          const fwhere = `${ewhere}/FormData[${fi + 1}]`;
          const form = formDef(fd.attrs.FormOID ?? "");
          if (!form || !def.forms.includes(form.oid))
            throw new PostError("EMU007", fwhere, `Form ${fd.attrs.FormOID ?? ""} not found in folder ${def.oid}`);
          const formKey = fd.attrs.FormRepeatKey ?? "1";
          let record = evt.forms.find((f) => f.formOid === form.oid && f.repeatKey === formKey);
          if (!record) {
            record = { formOid: form.oid, repeatKey: formKey, groups: [], modified: now() };
            evt.forms.push(record);
          }
          stats.Forms++;
          const rec = record;
          rec.modified = now();
          childrenNamed(fd, "ItemGroupData").forEach((gd, gi) => {
            const gwhere = `${fwhere}/ItemGroupData[${gi + 1}]`;
            const groupKey = gd.attrs.ItemGroupRepeatKey ?? gd.attrs["mdsol:RecordId"] ?? "1";
            if (!form.repeating && groupKey !== "1")
              throw new PostError("EMU008", gwhere, `Form ${form.oid} does not allow log lines`);
            let group = rec.groups.find((g) => g.repeatKey === groupKey);
            if (gd.attrs.TransactionType === "Remove") {
              if (group) rec.groups.splice(rec.groups.indexOf(group), 1);
              stats.LogLines++;
              return;
            }
            if (!group) {
              group = { repeatKey: groupKey, items: {} };
              rec.groups.push(group);
              if (form.repeating) stats.LogLines++;
            }
            const grp = group;
            childrenNamed(gd, "ItemData").forEach((id, ii) => {
              const iwhere = `${gwhere}/ItemData[${ii + 1}]`;
              const raw = id.attrs.ItemOID ?? "";
              const oid = raw.includes(".") ? raw : `${form.oid}.${raw}`;
              const item = form.items.find((x) => x.oid === oid);
              if (!item) throw new PostError("EMU009", iwhere, `Field ${raw} not found on form ${form.oid}`);
              const remove = id.attrs.TransactionType === "Remove" || id.attrs.IsNull === "Yes";
              const value = id.attrs.Value ?? "";
              if (!remove) {
                const bad =
                  (item.dataType === "integer" && !/^-?\d+$/.test(value)) ||
                  (item.dataType === "float" && !/^-?\d+(\.\d+)?$/.test(value)) ||
                  (item.dataType === "date" && !DATE.test(value)) ||
                  (item.codeList && !CODE_LISTS[item.codeList].some(([code]) => code === value));
                if (bad && value !== "")
                  throw new PostError(
                    "EMU010",
                    iwhere,
                    `Value ${value} is not valid for ${item.oid} (${item.dataType})`,
                  );
              }
              if (remove) delete grp.items[oid];
              else grp.items[oid] = value;
              stats.Fields++;
              w.audits.push({
                id: w.audits.length + 1,
                subjectUuid: target.uuid,
                eventOid: evt.eventOid,
                eventRepeatKey: evt.repeatKey,
                formOid: form.oid,
                formRepeatKey: rec.repeatKey,
                groupRepeatKey: grp.repeatKey,
                itemOid: oid,
                value: remove ? "" : value,
                subCategory: remove ? "Removed" : "Entered",
                user,
                site: target.site,
                time: now(),
              });
            });
          });
        });
      });
    });
  });
  for (const [study, w] of changed) {
    study.subjects = w.subjects;
    study.audits = w.audits;
  }
  return { stats, subjectNumbers };
}

// Inspector

function inspector(store: Store, tab: string): string {
  const all = studies(store);
  const current = all.find((s) => studyOid(s) === tab) ?? all[0];
  const tabs = all.map((s) => ({
    id: studyOid(s),
    label: `${studyOid(s)} (${s.subjects.filter((x) => !x.deleted).length})`,
    href: `/_inspector?study=${encodeURIComponent(studyOid(s))}`,
  }));
  const rows = (current?.subjects ?? []).map((s) => {
    const forms = s.events.flatMap((e) => e.forms);
    const aes = forms.filter((f) => f.formOid === "AE").reduce((n, f) => n + f.groups.length, 0);
    const link = `/RaveWebServices/studies/${encodeURIComponent(studyOid(current))}/subjects/${encodeURIComponent(s.key)}/datasets/regular`;
    return `<tr><td><a href="${escapeAttr(link)}">${escapeHtml(s.key)}</a></td><td><code>${escapeHtml(s.uuid)}</code></td><td>${escapeHtml(s.site)}</td><td>${escapeHtml(s.events.map((e) => e.eventOid).join(", "))}</td><td>${forms.length}</td><td>${aes}</td><td>${s.deleted ? '<span class="badge">deleted</span>' : ""}</td></tr>`;
  });
  const body = `<div class="inspector-section"><h2>Subjects</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>subject</th><th>UUID</th><th>site</th><th>folders</th><th>forms</th><th>adverse events</th><th></th></tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="7"><div class="inspector-empty">No subjects</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage("Medidata Rave inspector", tabs, current ? studyOid(current) : "", body, SERVICE_LABEL);
}

// Plugin

export const ravePlugin: ServicePlugin = {
  name: "rave",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const base = baseUrl.replace(/\/$/, "");
    const xml = (c: Context<AppEnv>, body: string, headers: Record<string, string> = {}) =>
      c.body(body, 200, { "Content-Type": "text/xml; charset=utf-8", ...headers });
    const text = (c: Context<AppEnv>, body: string) => c.text(body);
    const R = "/RaveWebServices";

    app.get(`${R}/version`, (c) => text(c, RWS_VERSION));
    app.get(`${R}/version/build`, (c) => text(c, "5.6.5.92"));
    app.get(`${R}/version/codename`, (c) => text(c, "Synthetic"));
    app.get(`${R}/diagnostics`, (c) => text(c, "OK"));
    app.get(`${R}/twohundred`, (c) =>
      c.html(
        renderCardPage(
          "RWS",
          "Rave Web Services",
          `<p>Emulated Rave Web Services ${RWS_VERSION}. Authentication is HTTP Basic; MAuth is not emulated.</p>`,
          SERVICE_LABEL,
        ),
      ),
    );

    // Everything else needs HTTP Basic credentials of an RWS user.
    app.use(`${R}/:rest{(?!version|diagnostics|twohundred).*}`, async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const [scheme, encoded] = header.split(" ");
      const [username, ...rest] =
        scheme?.toLowerCase() === "basic"
          ? Buffer.from(encoded ?? "", "base64")
              .toString()
              .split(":")
          : [];
      const user = users(store).find((u) => u.username === username && u.password === rest.join(":"));
      if (!user)
        return c.body(odm({ "mdsol:ErrorDescription": "Incorrect login and password combination. [RWS00008]" }), 401, {
          "Content-Type": "text/xml; charset=utf-8",
          "WWW-Authenticate": 'Basic realm="RaveWebServices"',
        });
      c.set("raveUser" as never, user.username as never);
      await next();
    });

    // Study lists
    app.get(`${R}/studies`, (c) =>
      xml(
        c,
        odm(
          {},
          ...studies(store).map((s) =>
            s.env === "Prod"
              ? studyListItem(s.project, s.project, s.project)
              : studyListItem(studyOid(s), `${s.project} (${s.env})`, s.project),
          ),
        ),
      ),
    );
    const projects = () => [...new Map(studies(store).map((s) => [s.project, s])).values()];
    app.get(`${R}/metadata/studies`, (c) =>
      xml(c, odm({}, ...projects().map((s) => studyListItem(s.project, s.project, s.project, "Project")))),
    );
    app.get(`${R}/metadata/libraries`, (c) =>
      xml(
        c,
        odm({}, studyListItem("SYN-LIBRARY", "Synthetic Standards Library", "SYN-LIBRARY", "GlobalLibraryVolume")),
      ),
    );
    const project = (c: Context<AppEnv>) => projects().find((s) => s.project === c.req.param("project"));
    const versionList = (c: Context<AppEnv>, drafts: boolean) => {
      const s = project(c);
      if (!s) return rwsError(c, 404, `Project ${c.req.param("project")} not found`);
      return xml(
        c,
        odm(
          {},
          el(
            "Study",
            { OID: s.project, "mdsol:ProjectType": "Project" },
            el(
              "GlobalVariables",
              {},
              textEl("StudyName", s.project),
              textEl("StudyDescription", s.description),
              textEl("ProtocolName", s.project),
            ),
            el(
              "MetaDataVersion",
              drafts
                ? { OID: `${s.versionOid}D`, Name: "Draft 1" }
                : { OID: s.versionOid, Name: `${s.project} CRF v1` },
            ),
          ),
        ),
      );
    };
    app.get(`${R}/metadata/studies/:project/versions`, (c) => versionList(c, false));
    app.get(`${R}/metadata/studies/:project/drafts`, (c) => versionList(c, true));
    app.get(`${R}/metadata/studies/:project/versions/:oid`, (c) => {
      const s = project(c);
      if (!s || c.req.param("oid") !== s.versionOid)
        return rwsError(c, 404, `CRF version ${c.req.param("oid")} not found in ${c.req.param("project")}`);
      return xml(
        c,
        odm(
          { FileType: "Snapshot", Description: s.description },
          el(
            "Study",
            { OID: s.project },
            el(
              "GlobalVariables",
              {},
              textEl("StudyName", s.project),
              textEl("StudyDescription", s.description),
              textEl("ProtocolName", s.project),
            ),
            el("BasicDefinitions", {}),
            metadataVersion(s),
          ),
        ),
      );
    });

    // Subjects and datasets
    const study = (c: Context<AppEnv>) => findStudy(store, c.req.param("studyenv"));
    app.get(`${R}/studies/:studyenv/subjects`, (c) => {
      const s = study(c);
      if (!s) return rwsError(c, 404, `Study ${c.req.param("studyenv")} not found`);
      const p = new URL(c.req.url).searchParams;
      const include = p.get("include") ?? "";
      const byUuid = p.get("subjectKeyType") === "SubjectUUID";
      const status = p.get("status") === "all";
      const links = p.get("links") === "all";
      const list = s.subjects.filter(
        (x) => (!x.deleted || /deleted/i.test(include)) && (x.active || /inactive/i.test(include)),
      );
      return xml(
        c,
        odm(
          {},
          ...list.map((x) => {
            const site = s.sites.find((y) => y.oid === x.site);
            const forms = x.events.flatMap((e) => e.forms);
            const statusAttrs = status
              ? {
                  "mdsol:Overdue": "No",
                  "mdsol:Touched": forms.length ? "Yes" : "No",
                  "mdsol:Empty": forms.length ? "No" : "Yes",
                  "mdsol:Incomplete": "No",
                  "mdsol:NonConformant": "No",
                  "mdsol:Verified": "No",
                  "mdsol:Frozen": "No",
                  "mdsol:Locked": "No",
                  "mdsol:Signed": "No",
                  "mdsol:ReadyForFreeze": "No",
                  "mdsol:ReadyForLock": "No",
                }
              : {};
            return el(
              "ClinicalData",
              { StudyOID: studyOid(s), MetaDataVersionOID: s.versionOid },
              el(
                "SubjectData",
                {
                  SubjectKey: byUuid ? x.uuid : x.key,
                  "mdsol:SubjectKeyType": byUuid ? "SubjectUUID" : "SubjectName",
                  "mdsol:SubjectName": byUuid ? x.key : undefined,
                  "mdsol:SubjectActive": x.active ? "Yes" : "No",
                  "mdsol:Deleted": x.deleted ? "Yes" : undefined,
                  ...statusAttrs,
                },
                el("SiteRef", { LocationOID: x.site, "mdsol:StudyEnvSiteNumber": site?.number }),
                links
                  ? el("mdsol:Link", {
                      "xlink:type": "simple",
                      "xlink:href": `${base}/MedidataRAVE/HandleLink.aspx?page=SubjectPage.aspx?ID=${x.number}`,
                    })
                  : undefined,
              ),
            );
          }),
        ),
      );
    });

    const dataset = (c: Context<AppEnv>, s: StudyEnv, subjects: Subject[]) => {
      const type = c.req.param("type");
      if (type !== "regular" && type !== "raw") return rwsError(c, 400, `Dataset type ${type} must be regular or raw`);
      const formOid = c.req.param("form") || undefined;
      if (formOid && !formDef(formOid)) return rwsError(c, 404, `Form ${formOid} not found`);
      const start = new URL(c.req.url).searchParams.get("start") ?? undefined;
      const blocks = subjects
        .filter((x) => !x.deleted)
        .map((x) => subjectData(s, x, formOid, start))
        .filter((b): b is string => Boolean(b));
      return xml(c, odm({ FileType: "Snapshot" }, ...blocks));
    };
    for (const suffix of ["", "/:form"]) {
      app.get(`${R}/studies/:studyenv/datasets/:type${suffix}`, (c) => {
        const s = study(c);
        return s ? dataset(c, s, s.subjects) : rwsError(c, 404, `Study ${c.req.param("studyenv")} not found`);
      });
      app.get(`${R}/studies/:studyenv/subjects/:subject/datasets/:type${suffix}`, (c) => {
        const s = study(c);
        if (!s) return rwsError(c, 404, `Study ${c.req.param("studyenv")} not found`);
        const key = c.req.param("subject");
        const subject = s.subjects.find((x) => (x.key === key || x.uuid === key) && !x.deleted);
        return subject ? dataset(c, s, [subject]) : rwsError(c, 404, `Subject ${key} not found`);
      });
      app.get(`${R}/studies/:studyenv/versions/:oid/datasets/:type${suffix}`, (c) => {
        const s = study(c);
        if (!s || s.versionOid !== c.req.param("oid")) return rwsError(c, 404, "Study or CRF version not found");
        return dataset(c, s, s.subjects);
      });
    }

    // Clinical audit records, as the ClinicalAuditRecords configurable dataset.
    app.get(`${R}/datasets/:name`, (c) => {
      const name = c.req.param("name").replace(/\.odm$/i, "");
      if (name !== "ClinicalAuditRecords") return rwsError(c, 404, `Dataset ${name} not found`);
      const p = new URL(c.req.url).searchParams;
      const s = findStudy(store, p.get("studyoid") ?? "");
      if (!s) return rwsError(c, 404, `Study ${p.get("studyoid") ?? ""} not found`);
      const startId = Math.max(Number(p.get("startid") ?? 1) || 1, 1);
      const perPage = Math.min(Math.max(Number(p.get("per_page") ?? 500) || 500, 1), 10000);
      const page = s.audits.filter((a) => a.id >= startId).slice(0, perPage);
      const blocks = page.map((a) => {
        const subject = s.subjects.find((x) => x.uuid === a.subjectUuid);
        return el(
          "ClinicalData",
          { StudyOID: studyOid(s), MetaDataVersionOID: s.versionOid, "mdsol:AuditSubCategoryName": a.subCategory },
          el(
            "SubjectData",
            { SubjectKey: a.subjectUuid, "mdsol:SubjectKeyType": "SubjectUUID", "mdsol:SubjectName": subject?.key },
            el("SiteRef", { LocationOID: a.site }),
            el(
              "StudyEventData",
              { StudyEventOID: a.eventOid, StudyEventRepeatKey: a.eventRepeatKey },
              el(
                "FormData",
                { FormOID: a.formOid, FormRepeatKey: a.formRepeatKey },
                el(
                  "ItemGroupData",
                  { ItemGroupOID: a.formOid, ItemGroupRepeatKey: a.groupRepeatKey },
                  el(
                    "ItemData",
                    { ItemOID: a.itemOid, Value: a.value },
                    el(
                      "AuditRecord",
                      {},
                      el("UserRef", { UserOID: a.user }),
                      el("LocationRef", { LocationOID: a.site }),
                      textEl("DateTimeStamp", a.time),
                      textEl("ReasonForChange", ""),
                      textEl("SourceID", String(a.id)),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      });
      const last = page[page.length - 1];
      const more = last && s.audits.some((a) => a.id > last.id);
      const headers: Record<string, string> = more
        ? {
            Link: `<${base}${R}/datasets/ClinicalAuditRecords.odm?studyoid=${encodeURIComponent(studyOid(s))}&startid=${last.id + 1}&per_page=${perPage}>; rel="next"`,
          }
        : {};
      return xml(c, odm({ FileType: "Transactional" }, ...blocks), headers);
    });

    // Import and cache flush through webservice.aspx
    app.post(`${R}/webservice.aspx`, async (c) => {
      if (!new URL(c.req.url).search.includes("PostODMClinicalData"))
        return rwsError(c, 405, "Use webservice.aspx?PostODMClinicalData");
      let root: XmlElement;
      try {
        root = parseXml(await c.req.text());
      } catch (error) {
        if (!(error instanceof XmlError)) throw error;
        return postError(c, "", "/", "EMU001", `The request is not well formed XML: ${error.message}`);
      }
      const fileOid = root.attrs.FileOID ?? "";
      try {
        const { stats, subjectNumbers } = applyImport(store, root, c.get("raveUser" as never) as unknown as string);
        return xml(
          c,
          `${el("Response", {
            ReferenceNumber: randomUUID(),
            InboundODMFileOID: fileOid,
            IsTransactionSuccessful: "1",
            SuccessStatistics: `Rave objects touched: Subjects=${stats.Subjects}; Folders=${stats.Folders}; Forms=${stats.Forms}; Fields=${stats.Fields}; LogLines=${stats.LogLines}`,
            NewRecords: "",
            SubjectNumberInStudy: subjectNumbers?.study,
            SubjectNumberInStudySite: subjectNumbers?.site,
          })}`,
        );
      } catch (error) {
        if (!(error instanceof PostError)) throw error;
        return postError(c, fileOid, error.location, error.code, error.message);
      }
    });
    app.get(`${R}/webservice.aspx`, (c) => {
      if (!new URL(c.req.url).search.includes("CacheFlush")) return rwsError(c, 405, "Unsupported request");
      return xml(
        c,
        `${el("Response", { ReferenceNumber: randomUUID(), IsTransactionSuccessful: "1", SuccessStatistics: "" })}`,
      );
    });

    app.get("/MedidataRAVE/HandleLink.aspx", (c) => c.redirect("/_inspector"));
    app.get("/_inspector", (c) => c.html(inspector(store, new URL(c.req.url).searchParams.get("study") ?? "")));
  },
  seed(store: Store): void {
    store.setData(KEY.studies, generateStudies());
  },
};

export default ravePlugin;
