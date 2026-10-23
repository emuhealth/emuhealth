// Reads Rave's ClinicalAuditRecords dataset: one ODM ClinicalData element per audit record, paged by a Link header.

export interface AuditRecord {
  sourceId: number;
  category: string;
  subject: string;
  folder: string;
  form: string;
  field: string;
  value: string;
  user: string;
  timestamp: string;
}

export interface AuditPage {
  records: AuditRecord[];
  next?: string;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const open = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>`))?.[0] ?? "";
const text = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";

export function parseAuditPage(xml: string): AuditRecord[] {
  return [...xml.matchAll(/<ClinicalData\b[\s\S]*?<\/ClinicalData>/g)].map(([record]) => {
    const item = open(record, "ItemData");
    return {
      sourceId: Number(text(record, "SourceID")),
      category: attr(open(record, "ClinicalData"), "mdsol:AuditSubCategoryName"),
      subject: unescape(
        attr(open(record, "SubjectData"), "mdsol:SubjectName") || attr(open(record, "SubjectData"), "SubjectKey"),
      ),
      folder: attr(open(record, "StudyEventData"), "StudyEventOID"),
      form: attr(open(record, "FormData"), "FormOID"),
      field: attr(item, "ItemOID"),
      value: unescape(attr(item, "Value")),
      user: attr(open(record, "UserRef"), "UserOID"),
      timestamp: text(record, "DateTimeStamp"),
    };
  });
}

export async function fetchAuditPage(url: string, auth: string): Promise<AuditPage> {
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}: ${await res.text()}`);
  const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  return { records: parseAuditPage(await res.text()), next };
}
