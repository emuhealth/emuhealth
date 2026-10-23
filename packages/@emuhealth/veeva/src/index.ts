import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import {
  DOCUMENT_PROPERTIES,
  OBJECTS,
  fileFields,
  generateDocuments,
  generateRecords,
  recordId,
  type DocumentVersion,
  type FieldDef,
  type ObjectDef,
  type VaultDocument,
  type VaultRecord,
} from "./data.js";
import { VqlError, fieldsOf, matches, parseVql, sortRecords, type Query } from "./vql.js";

export { OBJECTS, generateRecords, generateDocuments, recordId } from "./data.js";
export { parseVql, VqlError } from "./vql.js";

/** Veeva Vault REST API emulator: auth sessions, object records, documents, metadata, and VQL. */
export interface VeevaSeedConfig {
  port?: number;
  /** Vault users who can sign in with POST /api/{version}/auth. */
  users?: Array<{ username: string; password: string; id?: number; name?: string }>;
  /** Seed the synthetic products, studies, sites, countries, and documents (default true). */
  generate?: boolean;
  /** Extra object records by object name, such as product__v. */
  records?: Record<string, Array<Record<string, unknown>>>;
  /** Sessions expire after this many minutes without a request (default 20). */
  sessionTimeoutMinutes?: number;
}

interface User {
  username: string;
  password: string;
  id: number;
  name: string;
}

interface Session {
  userId: number;
  lastUsed: number;
}

const KEY = {
  records: "veeva.records",
  documents: "veeva.documents",
  sessions: "veeva.sessions",
  users: "veeva.users",
  queries: "veeva.queries",
  timeout: "veeva.timeout",
};
const SERVICE_LABEL = "Veeva Vault";
const VAULT_ID = 1000;
const VERSIONS = ["v24.1", "v24.2", "v24.3", "v25.1", "v25.2", "v25.3", "v26.1", "v26.2"];
export const DEFAULT_USER: User = {
  username: "admin@synthetic-vault.example",
  password: "synthetic-password",
  id: 1,
  name: "Synthetic Vault Admin",
};
const VERSION = ":version{v[0-9]+\\.[0-9]+}";

function data<T>(store: Store, key: string, make: () => T): T {
  let value = store.getData<T>(key);
  if (value === undefined) {
    value = make();
    store.setData(key, value);
  }
  return value;
}
const records = (store: Store) => data<Record<string, VaultRecord[]>>(store, KEY.records, () => ({}));
const documents = (store: Store) => data<VaultDocument[]>(store, KEY.documents, () => []);
const sessions = (store: Store) => data<Map<string, Session>>(store, KEY.sessions, () => new Map());
const users = (store: Store) => data<User[]>(store, KEY.users, () => [DEFAULT_USER]);
const queries = (store: Store) => data<Map<string, string>>(store, KEY.queries, () => new Map());

const objectDef = (name: string) => OBJECTS.find((o) => o.name === name);

// Record validation and storage

type Outcome = {
  responseStatus: "SUCCESS" | "FAILURE" | "WARNING";
  data?: unknown;
  errors?: Array<{ type: string; message: string }>;
};
const failure = (type: string, message: string): Outcome => ({
  responseStatus: "FAILURE",
  errors: [{ type, message }],
});

/** Coerce and check input fields; returns the normalized fields or an error message. */
function normalize(
  store: Store,
  def: ObjectDef,
  input: Record<string, unknown>,
  creating: boolean,
): { fields: Record<string, unknown> } | { error: Outcome } {
  const fields: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "id") continue;
    const field = def.fields.find((f) => f.name === key);
    if (!field)
      return { error: failure("ATTRIBUTE_NOT_SUPPORTED", `Field [${key}] does not exist on object [${def.name}]`) };
    if (field.editable === false) return { error: failure("INVALID_DATA", `Field [${key}] is not editable`) };
    if (raw === null || raw === "") {
      fields[key] = null;
      continue;
    }
    switch (field.type) {
      case "Number": {
        const n = Number(raw);
        if (!Number.isFinite(n))
          return { error: failure("INVALID_DATA", `Invalid value [${raw}] for Number field [${key}]`) };
        fields[key] = n;
        break;
      }
      case "Boolean":
        fields[key] = raw === true || raw === "true";
        break;
      case "Picklist": {
        const values = (Array.isArray(raw) ? raw : String(raw).split(",")).map((v) => String(v).trim());
        const bad = values.find((v) => !field.picklist?.includes(v));
        if (bad) return { error: failure("INVALID_DATA", `Invalid value [${bad}] for picklist field [${key}]`) };
        fields[key] = values;
        break;
      }
      case "Object": {
        const id = String(raw);
        if (!records(store)[field.object!]?.some((r) => r.id === id))
          return { error: failure("INVALID_DATA", `Invalid value [${id}] for object reference field [${key}]`) };
        fields[key] = id;
        break;
      }
      default:
        fields[key] = String(raw);
    }
  }
  if (creating)
    for (const f of def.fields)
      if (f.required && f.name !== "id" && (fields[f.name] === undefined || fields[f.name] === null))
        return { error: failure("PARAMETER_REQUIRED", `Missing required field [${f.name}]`) };
  return { fields };
}

function uniqueClash(store: Store, def: ObjectDef, fields: Record<string, unknown>, self?: string): string | undefined {
  for (const f of def.fields.filter((x) => x.unique && x.name !== "id")) {
    const v = fields[f.name];
    if (v !== undefined && v !== null && records(store)[def.name]?.some((r) => r.id !== self && r[f.name] === v))
      return f.name;
  }
  return undefined;
}

const nowIso = () => new Date().toISOString();

function createRecord(
  store: Store,
  def: ObjectDef,
  input: Record<string, unknown>,
  userId: number,
  version: string,
): Outcome {
  const normalized = normalize(store, def, input, true);
  if ("error" in normalized) return normalized.error;
  const clash = uniqueClash(store, def, normalized.fields);
  if (clash) return failure("INVALID_DATA", `Duplicate value for unique field [${clash}]`);
  const list = (records(store)[def.name] ??= []);
  let id = recordId(def.prefix, randomUUID());
  while (list.some((r) => r.id === id)) id = recordId(def.prefix, randomUUID());
  const stamp = nowIso();
  const rec: VaultRecord = {
    id,
    status__v: ["active__v"],
    external_id__v: null,
    created_by__v: userId,
    created_date__v: stamp,
    modified_by__v: userId,
    modified_date__v: stamp,
    ...normalized.fields,
  };
  list.push(rec);
  return { responseStatus: "SUCCESS", data: { id, url: `/api/${version}/vobjects/${def.name}/${id}` } };
}

function updateRecord(
  store: Store,
  def: ObjectDef,
  rec: VaultRecord,
  input: Record<string, unknown>,
  userId: number,
  version: string,
): Outcome {
  const normalized = normalize(store, def, input, false);
  if ("error" in normalized) return normalized.error;
  const clash = uniqueClash(store, def, normalized.fields, rec.id);
  if (clash) return failure("INVALID_DATA", `Duplicate value for unique field [${clash}]`);
  for (const f of def.fields)
    if (f.required && f.name in normalized.fields && normalized.fields[f.name] === null)
      return failure("PARAMETER_REQUIRED", `Missing required field [${f.name}]`);
  Object.assign(rec, normalized.fields, { modified_by__v: userId, modified_date__v: nowIso() });
  return { responseStatus: "SUCCESS", data: { id: rec.id, url: `/api/${version}/vobjects/${def.name}/${rec.id}` } };
}

/** Parse an RFC 4180 CSV body into objects keyed by the header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries((header ?? []).map((h, i) => [h.trim(), cells[i] ?? ""])));
}

// Seed

export function seedFromConfig(store: Store, _baseUrl: string, config: VeevaSeedConfig): void {
  if (config.generate === false) {
    store.setData(KEY.records, {});
    store.setData(KEY.documents, []);
  }
  if (config.users !== undefined) {
    if (!Array.isArray(config.users)) throw new Error("veeva.users must be an array");
    store.setData(
      KEY.users,
      config.users.map((u, i) => {
        if (typeof u?.username !== "string" || typeof u.password !== "string")
          throw new Error(`veeva.users[${i}] needs username and password`);
        return { username: u.username, password: u.password, id: u.id ?? 100 + i, name: u.name ?? u.username };
      }),
    );
  }
  if (config.sessionTimeoutMinutes !== undefined) {
    if (typeof config.sessionTimeoutMinutes !== "number" || config.sessionTimeoutMinutes <= 0)
      throw new Error("veeva.sessionTimeoutMinutes must be a positive number");
    store.setData(KEY.timeout, config.sessionTimeoutMinutes);
  }
  if (config.records === undefined) return;
  if (typeof config.records !== "object" || config.records === null) throw new Error("veeva.records must be an object");
  for (const [object, list] of Object.entries(config.records)) {
    const def = objectDef(object);
    if (!def) throw new Error(`veeva.records.${object}: unknown object; use ${OBJECTS.map((o) => o.name).join(", ")}`);
    if (!Array.isArray(list)) throw new Error(`veeva.records.${object} must be an array`);
    for (const [i, input] of list.entries()) {
      const result = createRecord(store, def, input, 1, "v24.3");
      if (result.responseStatus !== "SUCCESS")
        throw new Error(`veeva.records.${object}[${i}]: ${result.errors?.[0]?.message}`);
    }
  }
}

// Documents

function latest(doc: VaultDocument): DocumentVersion {
  return doc.versions[doc.versions.length - 1];
}

function documentFields(doc: VaultDocument, v: DocumentVersion): Record<string, unknown> {
  const { file: _file, ...fields } = v;
  return {
    id: doc.id,
    version_id: `${doc.id}_${v.major_version_number__v}_${v.minor_version_number__v}`,
    ...fields,
  };
}

const versionUrl = (base: string, version: string, doc: VaultDocument, v: DocumentVersion) =>
  `${base}/api/${version}/objects/documents/${doc.id}/versions/${v.major_version_number__v}/${v.minor_version_number__v}`;

// Query

function relationValue(store: Store, row: Record<string, unknown>, field: string, defs: FieldDef[]): unknown {
  const [relation, target] = field.split(".");
  const base = relation.replace(/__(vr|cr)$/, (_, s: string) => (s === "vr" ? "__v" : "__c"));
  const def = defs.find((f) => f.name === base && f.type === "Object");
  if (!def || !target) return undefined;
  const ref = row[base];
  const lookup = (id: unknown) => records(store)[def.object!]?.find((r) => r.id === id)?.[target] ?? null;
  return Array.isArray(ref) ? ref.map(lookup) : ref === null || ref === undefined ? null : lookup(ref);
}

function runQuery(store: Store, q: Query): { rows: Array<Record<string, unknown>>; describe: Record<string, unknown> } {
  let defs: FieldDef[];
  let rows: Array<Record<string, unknown>>;
  let label: { name: string; label: string; label_plural: string };
  if (q.target === "documents") {
    defs = DOCUMENT_PROPERTIES;
    rows = documents(store).map((d) => documentFields(d, latest(d)));
    label = { name: "documents", label: "documents", label_plural: "documents" };
  } else {
    const def = objectDef(q.target);
    if (!def) throw new VqlError(`Invalid query target [${q.target}]`);
    defs = def.fields;
    rows = records(store)[def.name] ?? [];
    label = { name: def.name, label: def.label, label_plural: def.label_plural };
  }
  const known = new Set(defs.map((f) => f.name));
  const needed = [...q.fields, ...fieldsOf(q.where), ...q.orderBy.map((o) => o.field)];
  for (const field of needed)
    if (!known.has(field) && !(field.includes(".") && relationValue(store, {}, field, defs) !== undefined))
      throw new VqlError(`No such field [${field}] on [${q.target}]`);
  const extended = rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const f of needed) if (f.includes(".")) out[f] = relationValue(store, row, f, defs);
    return out;
  });
  const filtered = sortRecords(
    extended.filter((r) => matches(r, q.where)),
    q.orderBy,
  ).slice(0, q.maxRows ?? undefined);
  const describe = {
    object: label,
    fields: q.fields.map((name) => {
      const f = defs.find((d) => d.name === name);
      return f
        ? { type: f.type, required: Boolean(f.required), name: f.name, label: f.label }
        : { type: "String", required: false, name, label: name };
    }),
  };
  return {
    rows: filtered.map((r) => Object.fromEntries(q.fields.map((f) => [f, r[f] ?? null]))),
    describe,
  };
}

// Inspector

function inspector(store: Store, tab: string): string {
  const tabs = [
    ...OBJECTS.map((o) => ({
      id: o.name,
      label: `${o.label_plural} (${(records(store)[o.name] ?? []).length})`,
      href: `/_inspector?tab=${o.name}`,
    })),
    { id: "documents", label: `Documents (${documents(store).length})`, href: "/_inspector?tab=documents" },
  ];
  let body: string;
  if (tab === "documents") {
    const rows = documents(store).map((d) => {
      const v = latest(d);
      return `<tr><td>${d.id}</td><td>${escapeHtml(String(v.document_number__v ?? ""))}</td><td>${escapeHtml(String(v.name__v ?? ""))}</td><td>${escapeHtml(String(v.classification__v ?? v.type__v ?? ""))}</td><td><span class="badge">${escapeHtml(String(v.status__v ?? ""))}</span></td><td>${v.major_version_number__v}.${v.minor_version_number__v}</td></tr>`;
    });
    body = `<div class="inspector-section"><h2>Documents</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>ID</th><th>number</th><th>name</th><th>classification</th><th>status</th><th>version</th></tr></thead><tbody>${
      rows.length ? rows.join("") : '<tr><td colspan="6"><div class="inspector-empty">No documents</div></td></tr>'
    }</tbody></table></div></div>`;
  } else {
    const def = objectDef(tab) ?? OBJECTS[0];
    const columns = def.fields.filter((f) => !/^(created|modified)_/.test(f.name) && f.name !== "external_id__v");
    const rows = (records(store)[def.name] ?? []).map(
      (r) =>
        `<tr>${columns
          .map((f) => {
            const v = r[f.name];
            return `<td>${escapeHtml(v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v))}</td>`;
          })
          .join("")}</tr>`,
    );
    body = `<div class="inspector-section"><h2>${escapeHtml(def.label_plural)} <code>${escapeHtml(def.name)}</code></h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${columns
      .map((f) => `<th>${escapeHtml(f.name)}</th>`)
      .join("")}</tr></thead><tbody>${
      rows.length
        ? rows.join("")
        : `<tr><td colspan="${columns.length}"><div class="inspector-empty">No records</div></td></tr>`
    }</tbody></table></div></div>`;
    tab = def.name;
  }
  return renderInspectorPage("Veeva Vault inspector", tabs, tab, body, SERVICE_LABEL);
}

// Plugin

export const veevaPlugin: ServicePlugin = {
  name: "veeva",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const base = baseUrl.replace(/\/$/, "");
    const ok = (c: Context<AppEnv>, body: Record<string, unknown>) => c.json({ responseStatus: "SUCCESS", ...body });
    const fail = (c: Context<AppEnv>, type: string, message: string, status: 200 | 404 = 200) =>
      c.json({ responseStatus: "FAILURE", errors: [{ type, message }] }, status);
    const userOf = (c: Context<AppEnv>) => c.get("veevaUser" as never) as unknown as number;

    app.get("/api", (c) => ok(c, { values: Object.fromEntries(VERSIONS.map((v) => [v, `${base}/api/${v}`])) }));
    app.get("/api/", (c) => ok(c, { values: Object.fromEntries(VERSIONS.map((v) => [v, `${base}/api/${v}`])) }));

    app.post(`/api/${VERSION}/auth`, async (c) => {
      const body = await c.req.parseBody();
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username) return fail(c, "PARAMETER_REQUIRED", "Missing required parameter [username]");
      if (!password) return fail(c, "NO_PASSWORD_PROVIDED", "No password was provided for the login call.");
      const user = users(store).find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!user || user.password !== password)
        return fail(c, "USERNAME_OR_PASSWORD_INCORRECT", `Authentication failed for user: ${username}.`);
      const sessionId = randomBytes(48).toString("hex").toUpperCase();
      sessions(store).set(sessionId, { userId: user.id, lastUsed: Date.now() });
      return ok(c, {
        sessionId,
        userId: user.id,
        vaultIds: [{ id: VAULT_ID, name: "Synthetic Vault", url: `${base}/api` }],
        vaultId: VAULT_ID,
      });
    });

    // Every other versioned route needs a session in the Authorization header.
    app.use(`/api/:rest{v[0-9]+\\.[0-9]+/(?!auth$).*}`, async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const id = header.replace(/^Bearer\s+/i, "").trim();
      const session = id ? sessions(store).get(id) : undefined;
      const timeout = (store.getData<number>(KEY.timeout) ?? 20) * 60_000;
      if (!session || Date.now() - session.lastUsed > timeout) {
        if (session) sessions(store).delete(id);
        return fail(c, "INVALID_SESSION_ID", "Invalid or expired session ID.");
      }
      session.lastUsed = Date.now();
      c.set("veevaUser" as never, session.userId as never);
      c.set("veevaSession" as never, id as never);
      await next();
    });

    app.post(`/api/${VERSION}/keep-alive`, (c) => ok(c, {}));
    app.delete(`/api/${VERSION}/session`, (c) => {
      sessions(store).delete(c.get("veevaSession" as never) as unknown as string);
      return ok(c, {});
    });

    // Metadata
    const objectSummary = (version: string, def: ObjectDef) => ({
      url: `/api/${version}/metadata/vobjects/${def.name}`,
      label: def.label,
      name: def.name,
      label_plural: def.label_plural,
      prefix: def.prefix,
      status: ["active__v"],
      configuration_state: "STEADY_STATE",
    });
    const describeField = (f: FieldDef) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: Boolean(f.required),
      editable: f.editable !== false,
      unique: Boolean(f.unique),
      ...(f.object ? { object: { name: f.object }, relationship_name: f.name.replace(/__(v|c)$/, "__$1r") } : {}),
      ...(f.picklist ? { picklist: f.name, values: f.picklist } : {}),
    });
    app.get(`/api/${VERSION}/metadata/vobjects`, (c) =>
      ok(c, { objects: OBJECTS.map((o) => objectSummary(c.req.param("version"), o)) }),
    );
    app.get(`/api/${VERSION}/metadata/vobjects/:object`, (c) => {
      const def = objectDef(c.req.param("object"));
      if (!def) return fail(c, "MALFORMED_URL", "The specified resource cannot be found.", 404);
      return ok(c, {
        object: { ...objectSummary(c.req.param("version"), def), fields: def.fields.map(describeField) },
      });
    });
    app.get(`/api/${VERSION}/metadata/objects/documents/properties`, (c) =>
      ok(c, { properties: DOCUMENT_PROPERTIES.map((f) => ({ ...describeField(f), queryable: true })) }),
    );

    // Object records
    const withDef = (c: Context<AppEnv>) => objectDef(c.req.param("object"));
    app.get(`/api/${VERSION}/vobjects/:object`, (c) => {
      const def = withDef(c);
      if (!def) return fail(c, "MALFORMED_URL", "The specified resource cannot be found.", 404);
      const version = c.req.param("version");
      const p = new URL(c.req.url).searchParams;
      const fields = (p.get("fields") ?? "id,name__v")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      const unknown = fields.find((f) => !def.fields.some((d) => d.name === f));
      if (unknown) return fail(c, "INVALID_DATA", `Invalid field [${unknown}]`);
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 200) || 200, 1), 200);
      const offset = Math.max(Number(p.get("offset") ?? 0) || 0, 0);
      let list = records(store)[def.name] ?? [];
      const sort = p.get("sort");
      if (sort) {
        const [field, dir] = sort.trim().split(/\s+/);
        if (!def.fields.some((d) => d.name === field)) return fail(c, "INVALID_DATA", `Invalid sort field [${field}]`);
        list = sortRecords(list, [{ field, desc: dir?.toLowerCase() === "desc" }]);
      }
      const page = list.slice(offset, offset + limit);
      const url = `/api/${version}/vobjects/${def.name}`;
      const link = (o: number) =>
        `${url}?limit=${limit}&offset=${o}${p.get("fields") ? `&fields=${p.get("fields")}` : ""}`;
      return ok(c, {
        responseDetails: {
          total: list.length,
          offset,
          limit,
          url: `${url}?${p.toString()}`,
          ...(offset + limit < list.length ? { next_page: link(offset + limit) } : {}),
          ...(offset > 0 ? { previous_page: link(Math.max(offset - limit, 0)) } : {}),
          object: objectSummary(version, def),
        },
        data: page.map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null]))),
      });
    });
    app.get(`/api/${VERSION}/vobjects/:object/:id`, (c) => {
      const def = withDef(c);
      const rec = def && records(store)[def.name]?.find((r) => r.id === c.req.param("id"));
      if (!def || !rec) return fail(c, "MALFORMED_URL", "The specified resource cannot be found.", 404);
      const version = c.req.param("version");
      const full = Object.fromEntries(def.fields.map((f) => [f.name, rec[f.name] ?? null]));
      return ok(c, {
        responseDetails: { url: `/api/${version}/vobjects/${def.name}/${rec.id}`, object: objectSummary(version, def) },
        data: full,
      });
    });

    const readBatch = async (c: Context<AppEnv>): Promise<Array<Record<string, unknown>> | string> => {
      const type = c.req.header("content-type") ?? "";
      const text = await c.req.text();
      if (type.includes("text/csv")) return parseCsv(text);
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed) && parsed.every((r) => r && typeof r === "object" && !Array.isArray(r)))
          return parsed as Array<Record<string, unknown>>;
      } catch {
        // fall through
      }
      return "The body must be a JSON array of records or a CSV file";
    };
    const batch = async (
      c: Context<AppEnv>,
      apply: (def: ObjectDef, input: Record<string, unknown>, version: string) => Outcome,
    ) => {
      const def = withDef(c);
      if (!def) return fail(c, "MALFORMED_URL", "The specified resource cannot be found.", 404);
      const input = await readBatch(c);
      if (typeof input === "string") return fail(c, "INVALID_DATA", input);
      if (!input.length) return fail(c, "PARAMETER_REQUIRED", "The request has no records");
      if (input.length > 500) return fail(c, "INVALID_DATA", "A request can create or update at most 500 records");
      const results = input.map((r) => apply(def, r, c.req.param("version")));
      return ok(c, { data: results });
    };

    app.post(`/api/${VERSION}/vobjects/:object`, async (c) => {
      const idParam = new URL(c.req.url).searchParams.get("idParam");
      const def = withDef(c);
      if (idParam && def && !def.fields.some((f) => f.name === idParam && (f.unique || f.name === "id")))
        return fail(c, "INVALID_DATA", `[${idParam}] is not a unique field`);
      return batch(c, (d, input, version) => {
        if (idParam) {
          const key = input[idParam];
          const existing = records(store)[d.name]?.find((r) => key !== undefined && key !== "" && r[idParam] === key);
          if (existing) {
            const { [idParam]: _key, ...rest } = input;
            return updateRecord(store, d, existing, idParam === "id" ? rest : input, userOf(c), version);
          }
        }
        return createRecord(store, d, input, userOf(c), version);
      });
    });
    app.put(`/api/${VERSION}/vobjects/:object`, (c) => {
      const idParam = new URL(c.req.url).searchParams.get("idParam") ?? "id";
      return batch(c, (d, input, version) => {
        const key = input[idParam];
        const existing = records(store)[d.name]?.find((r) => key !== undefined && r[idParam] === key);
        if (!existing) return failure("INVALID_DATA", `Record not found for [${idParam}] = [${String(key ?? "")}]`);
        const { [idParam]: _key, ...rest } = input;
        return updateRecord(store, d, existing, idParam === "id" ? rest : input, userOf(c), version);
      });
    });
    app.delete(`/api/${VERSION}/vobjects/:object`, (c) =>
      batch(c, (d, input, version) => {
        const list = records(store)[d.name] ?? [];
        const i = list.findIndex((r) => r.id === input.id);
        if (i < 0) return failure("INVALID_DATA", `Record not found for [id] = [${String(input.id ?? "")}]`);
        const referenced = OBJECTS.some((o) =>
          o.fields.some((f) => f.object === d.name && records(store)[o.name]?.some((r) => r[f.name] === input.id)),
        );
        if (referenced)
          return failure("OPERATION_NOT_ALLOWED", `Record [${String(input.id)}] is referenced by other records`);
        list.splice(i, 1);
        return {
          responseStatus: "SUCCESS",
          data: { id: input.id, url: `/api/${version}/vobjects/${d.name}/${String(input.id)}` },
        };
      }),
    );

    // Documents
    app.get(`/api/${VERSION}/objects/documents`, (c) => {
      const p = new URL(c.req.url).searchParams;
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 200) || 200, 1), 1000);
      const start = Math.max(Number(p.get("start") ?? 0) || 0, 0);
      const search = p.get("search")?.toLowerCase();
      const all = p.get("versionscope") === "all";
      let rows = documents(store).flatMap((d) => (all ? d.versions : [latest(d)]).map((v) => documentFields(d, v)));
      if (search)
        rows = rows.filter((r) =>
          ["name__v", "title__v", "document_number__v"].some((f) =>
            String(r[f] ?? "")
              .toLowerCase()
              .includes(search),
          ),
        );
      const [field, dir] = (p.get("sort") ?? "id ASC").trim().split(/\s+/);
      rows = sortRecords(rows, [{ field, desc: dir?.toUpperCase() === "DESC" }]);
      const page = rows.slice(start, start + limit);
      return ok(c, { size: page.length, start, limit, documents: page.map((document) => ({ document })) });
    });
    const findDoc = (c: Context<AppEnv>) => documents(store).find((d) => d.id === Number(c.req.param("id")));
    const docBody = (c: Context<AppEnv>, doc: VaultDocument, v: DocumentVersion) => {
      const version = c.req.param("version");
      return ok(c, {
        document: documentFields(doc, v),
        versions: doc.versions.map((x) => ({
          number: `${x.major_version_number__v}.${x.minor_version_number__v}`,
          value: versionUrl(base, version, doc, x),
        })),
        renditions: v.file
          ? {
              viewable_rendition__v: `${base}/api/${version}/objects/documents/${doc.id}/renditions/viewable_rendition__v`,
            }
          : {},
      });
    };
    app.get(`/api/${VERSION}/objects/documents/:id{[0-9]+}`, (c) => {
      const doc = findDoc(c);
      return doc ? docBody(c, doc, latest(doc)) : fail(c, "INVALID_DATA", "Invalid document ID");
    });
    app.get(`/api/${VERSION}/objects/documents/:id{[0-9]+}/versions/:major{[0-9]+}/:minor{[0-9]+}`, (c) => {
      const doc = findDoc(c);
      const v = doc?.versions.find(
        (x) =>
          x.major_version_number__v === Number(c.req.param("major")) &&
          x.minor_version_number__v === Number(c.req.param("minor")),
      );
      return doc && v ? docBody(c, doc, v) : fail(c, "INVALID_DATA", "Invalid document ID or version");
    });
    const download = (c: Context<AppEnv>) => {
      const doc = findDoc(c);
      const file = doc && latest(doc).file;
      if (!doc || !file) return fail(c, "INVALID_DATA", "The document has no source file");
      return c.body(new Uint8Array(file.content), 200, {
        "Content-Type": "application/octet-stream;charset=UTF-8",
        "Content-Disposition": `attachment;filename="${file.name.replace(/"/g, "")}"`,
      });
    };
    app.get(`/api/${VERSION}/objects/documents/:id{[0-9]+}/file`, download);
    app.get(`/api/${VERSION}/objects/documents/:id{[0-9]+}/renditions/:type`, download);

    const documentInput = async (c: Context<AppEnv>, creating: boolean) => {
      const body = await c.req.parseBody();
      const fields: Record<string, unknown> = {};
      let file: DocumentVersion["file"];
      for (const [key, value] of Object.entries(body)) {
        const v = Array.isArray(value) ? value[0] : value;
        if (key === "file") {
          if (typeof v === "string") return `The file must be uploaded as a multipart file`;
          file = {
            name: v.name || "upload",
            type: v.type || "application/octet-stream",
            content: Buffer.from(await v.arrayBuffer()),
          };
          continue;
        }
        const prop = DOCUMENT_PROPERTIES.find((p) => p.name === key);
        if (!prop) return `Field [${key}] does not exist on documents`;
        if (prop.editable === false) return `Field [${key}] is not editable`;
        fields[key] = prop.multi
          ? String(v)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : String(v);
      }
      if (creating)
        for (const required of ["name__v", "type__v", "lifecycle__v"])
          if (!fields[required]) return `Missing required field [${required}]`;
      return { fields, file };
    };
    app.post(`/api/${VERSION}/objects/documents`, async (c) => {
      const input = await documentInput(c, true);
      if (typeof input === "string") return fail(c, "INVALID_DATA", input);
      const list = documents(store);
      const id = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
      const stamp = nowIso();
      list.push({
        id,
        versions: [
          {
            title__v: null,
            subtype__v: null,
            classification__v: null,
            product__v: [],
            study__v: [],
            ...input.fields,
            status__v: "Draft",
            document_number__v: `VV-SYN-${String(id).padStart(5, "0")}`,
            major_version_number__v: 0,
            minor_version_number__v: 1,
            binder__v: false,
            created_by__v: userOf(c),
            document_creation_date__v: stamp,
            version_modified_date__v: stamp,
            ...(input.file ? { ...fileFields(input.file), file: input.file } : {}),
          },
        ],
      });
      return ok(c, { responseMessage: "successfully created document", id });
    });
    app.put(`/api/${VERSION}/objects/documents/:id{[0-9]+}`, async (c) => {
      const doc = findDoc(c);
      if (!doc) return fail(c, "INVALID_DATA", "Invalid document ID");
      const input = await documentInput(c, false);
      if (typeof input === "string") return fail(c, "INVALID_DATA", input);
      Object.assign(latest(doc), input.fields, { version_modified_date__v: nowIso() });
      return ok(c, { id: doc.id });
    });
    app.delete(`/api/${VERSION}/objects/documents/:id{[0-9]+}`, (c) => {
      const list = documents(store);
      const i = list.findIndex((d) => d.id === Number(c.req.param("id")));
      if (i < 0) return fail(c, "INVALID_DATA", "Invalid document ID");
      list.splice(i, 1);
      return ok(c, { id: Number(c.req.param("id")) });
    });

    // VQL
    const answer = (c: Context<AppEnv>, text: string, pageSize?: number, pageOffset?: number) => {
      let q: Query;
      try {
        q = parseVql(text);
      } catch (error) {
        if (error instanceof VqlError) return fail(c, "INCORRECT_QUERY_SYNTAX_ERROR", error.message);
        throw error;
      }
      let result: ReturnType<typeof runQuery>;
      try {
        result = runQuery(store, q);
      } catch (error) {
        if (error instanceof VqlError) return fail(c, "INVALID_DATA", error.message);
        throw error;
      }
      const size = Math.min(pageSize ?? q.pageSize ?? 1000, 1000);
      const offset = pageOffset ?? q.pageOffset ?? 0;
      const rows = result.rows.slice(offset, offset + size);
      let queryId = [...queries(store).entries()].find(([, t]) => t === text)?.[0];
      if (!queryId) {
        queryId = randomUUID();
        queries(store).set(queryId, text);
      }
      const page = (o: number) => `/api/${c.req.param("version")}/query/${queryId}?pagesize=${size}&pageoffset=${o}`;
      const describe = c.req.header("x-vaultapi-describequery") === "true";
      return ok(c, {
        ...(describe ? { queryDescribe: result.describe } : {}),
        responseDetails: {
          pagesize: size,
          pageoffset: offset,
          size: rows.length,
          total: result.rows.length,
          ...(offset > 0 ? { previous_page: page(Math.max(offset - size, 0)) } : {}),
          ...(offset + size < result.rows.length ? { next_page: page(offset + size) } : {}),
        },
        data: rows,
      });
    };
    const queryHandler = async (c: Context<AppEnv>) => {
      const body = c.req.method === "POST" ? await c.req.parseBody() : {};
      const q = (typeof body.q === "string" ? body.q : undefined) ?? new URL(c.req.url).searchParams.get("q");
      if (!q) return fail(c, "PARAMETER_REQUIRED", "Missing required parameter [q]");
      return answer(c, q);
    };
    app.post(`/api/${VERSION}/query`, queryHandler);
    app.get(`/api/${VERSION}/query`, queryHandler);
    app.get(`/api/${VERSION}/query/:qid`, (c) => {
      const text = queries(store).get(c.req.param("qid"));
      if (!text) return fail(c, "INVALID_DATA", "The query page has expired; run the query again");
      const p = new URL(c.req.url).searchParams;
      return answer(c, text, Number(p.get("pagesize")) || undefined, Number(p.get("pageoffset")) || 0);
    });

    for (const method of ["GET", "POST", "PUT", "DELETE"])
      app.on(method, "/api/:rest{.*}", (c) => fail(c, "MALFORMED_URL", "The specified resource cannot be found.", 404));
    app.get("/_inspector", (c) => c.html(inspector(store, new URL(c.req.url).searchParams.get("tab") ?? "")));
  },
  seed(store: Store): void {
    const recs = generateRecords();
    store.setData(KEY.records, recs);
    store.setData(KEY.documents, generateDocuments(recs));
  },
};

export default veevaPlugin;
