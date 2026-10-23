import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateProject, type Field, type GenerateOptions, type Project, type Row } from "./project.js";

export {
  generateProject,
  METADATA,
  INSTRUMENTS,
  type Field,
  type GenerateOptions,
  type Project,
  type Row,
} from "./project.js";

/**
 * REDCap API emulator: POST /api/ with token and content (version, project, metadata, instrument,
 * exportFieldNames, record export, import, and delete, generateNextRecordName) in json, csv, or xml, for a
 * synthetic classic project.
 */
export interface RedcapSeedConfig {
  port?: number;
  /** API tokens (32 hexadecimal characters). Default: the synthetic token 5E7E0000000000000000000000000001. */
  tokens?: string[];
  /** Generated records; false starts with the data dictionary only. */
  generate?: GenerateOptions | false;
  /** Your own records in flat format, for example { record_id: "100", sex: "1" }. */
  records?: Row[];
}

const DATA_KEY = "redcap.project";
const TOKENS_KEY = "redcap.tokens";
export const DEFAULT_TOKEN = "5E7E0000000000000000000000000001";
const SERVICE_LABEL = "REDCap";
const VERSION = "14.5.0";

function project(store: Store): Project {
  let p = store.getData<Project>(DATA_KEY);
  if (!p) {
    p = generateProject();
    store.setData(DATA_KEY, p);
  }
  return p;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: RedcapSeedConfig): void {
  if (config.tokens !== undefined) {
    if (!Array.isArray(config.tokens) || config.tokens.some((t) => typeof t !== "string" || !/^[0-9A-F]{32}$/i.test(t)))
      throw new Error("redcap.tokens must be an array of 32 character hexadecimal tokens");
    store.setData(
      TOKENS_KEY,
      config.tokens.map((t) => t.toUpperCase()),
    );
  }
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("redcap.generate must be an object of generator options or false");
    const p = generateProject(config.generate === false ? { records: 0 } : config.generate);
    store.setData(DATA_KEY, p);
  }
  if (config.records === undefined) return;
  if (!Array.isArray(config.records)) throw new Error("redcap.records must be an array");
  const errors = importRecords(project(store), config.records, "overwrite");
  if (errors.length) throw new Error(`redcap.records: ${errors.join("; ")}`);
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Checkbox fields export as field___code columns. */
function choices(f: Field): Array<{ code: string; label: string }> {
  if (!["radio", "dropdown", "checkbox"].includes(f.field_type)) {
    if (f.field_type === "yesno")
      return [
        { code: "1", label: "Yes" },
        { code: "0", label: "No" },
      ];
    if (f.field_type === "truefalse")
      return [
        { code: "1", label: "True" },
        { code: "0", label: "False" },
      ];
    return [];
  }
  return f.select_choices_or_calculations
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [code, ...label] = c.split(",");
      return { code: code.trim(), label: label.join(",").trim() };
    });
}

/**
 * Export columns in data dictionary order. With no fields or forms: everything and every form_complete. Fields
 * add those fields; forms add every field of the form and its form_complete. The record id is always first.
 */
function columns(p: Project, fields: string[] = [], forms: string[] = []): string[] {
  const all = !fields.length && !forms.length;
  const out: string[] = [p.metadata[0].field_name];
  for (const { instrument_name: form } of p.instruments) {
    const wholeForm = all || forms.includes(form);
    for (const f of p.metadata.filter((m) => m.form_name === form && m.field_type !== "descriptive")) {
      if (!wholeForm && !fields.includes(f.field_name)) continue;
      if (f.field_type === "checkbox") for (const c of choices(f)) out.push(`${f.field_name}___${c.code}`);
      else out.push(f.field_name);
    }
    if (wholeForm) out.push(`${form}_complete`);
  }
  return [...new Set(out)];
}

// filterLogic: [field] comparisons joined by and/or, with parentheses.

function evaluateLogic(logic: string, row: Row): boolean {
  const tokens = logic.match(/\[[^\]]+\]|'[^']*'|"[^"]*"|<>|!=|>=|<=|=|>|<|\(|\)|\band\b|\bor\b|[^\s()]+/gi) ?? [];
  let pos = 0;
  const value = (): string | number => {
    const t = tokens[pos++];
    if (t === undefined) throw new ApiError(400, "The filterLogic is not valid");
    if (t.startsWith("[")) {
      const name = t.slice(1, -1).replace(/\((\w+)\)$/, "___$1");
      return row[name] ?? "";
    }
    if (/^['"]/.test(t)) return t.slice(1, -1);
    return t;
  };
  const comparison = (): boolean => {
    if (tokens[pos] === "(") {
      pos++;
      const inner = or();
      if (tokens[pos++] !== ")") throw new ApiError(400, "The filterLogic is not valid");
      return inner;
    }
    const left = value();
    const op = tokens[pos++];
    const right = value();
    const numeric = left !== "" && right !== "" && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
    const a = numeric ? Number(left) : String(left);
    const b = numeric ? Number(right) : String(right);
    switch (op) {
      case "=":
        return a === b;
      case "<>":
      case "!=":
        return a !== b;
      case ">":
        return a > b;
      case "<":
        return a < b;
      case ">=":
        return a >= b;
      case "<=":
        return a <= b;
      default:
        throw new ApiError(400, "The filterLogic is not valid");
    }
  };
  const and = (): boolean => {
    let result = comparison();
    while (tokens[pos]?.toLowerCase() === "and") {
      pos++;
      result = comparison() && result;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (tokens[pos]?.toLowerCase() === "or") {
      pos++;
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (pos !== tokens.length) throw new ApiError(400, "The filterLogic is not valid");
  return result;
}

function importRecords(p: Project, rows: Row[], overwrite: string): string[] {
  const key = p.metadata[0].field_name;
  const known = new Set(columns(p));
  const errors: string[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      errors.push(`row ${i + 1} is not an object`);
      continue;
    }
    if (!row[key]) errors.push(`row ${i + 1} has no ${key}`);
    for (const name of Object.keys(row)) if (!known.has(name)) errors.push(`"${name}" is not a field in this project`);
    for (const f of p.metadata) {
      const v = row[f.field_name];
      if (v === undefined || v === "") continue;
      const valid = choices(f).map((c) => c.code);
      if (valid.length && f.field_type !== "checkbox" && !valid.includes(String(v)))
        errors.push(`${row[key]}: "${v}" is not a valid choice for ${f.field_name}`);
      const validation = f.text_validation_type_or_show_slider_number;
      if ((validation === "number" || validation === "integer") && Number.isNaN(Number(v)))
        errors.push(`${row[key]}: "${v}" is not a number for ${f.field_name}`);
      if (validation === "date_ymd" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
        errors.push(`${row[key]}: "${v}" is not a date (Y-M-D) for ${f.field_name}`);
    }
  }
  if (errors.length) return errors;
  for (const row of rows) {
    const existing = p.records.find((r) => r[key] === String(row[key]));
    const values = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]),
    );
    if (existing) {
      for (const [k, v] of Object.entries(values)) if (v !== "" || overwrite === "overwrite") existing[k] = v;
    } else {
      const blank = Object.fromEntries(columns(p).map((c) => [c, c.includes("___") ? "0" : ""]));
      p.records.push({ ...blank, ...values });
    }
  }
  return [];
}

// Output formats

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows: Array<Record<string, unknown>>, header?: string[]): string {
  const cols = header ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

const cdata = (v: unknown) => `<![CDATA[${String(v ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

function toXml(root: string, rows: Array<Record<string, unknown>>): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<${root}>${rows
    .map(
      (r) =>
        `<item>${Object.entries(r)
          .map(([k, v]) => `<${k}>${cdata(v)}</${k}>`)
          .join("")}</item>`,
    )
    .join("")}</${root}>`;
}

function parseCsv(text: string): Row[] {
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
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((c) => c !== ""));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Form fields arrive as records[0]=1&records[1]=2 or records=1,2. */
function list(form: URLSearchParams, name: string): string[] {
  const indexed = [...form.entries()].filter(([k]) => k === name || k.startsWith(`${name}[`)).map(([, v]) => v);
  return indexed
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

type AnyContext = Context<AppEnv>;

function respond(
  c: AnyContext,
  format: string,
  root: string,
  rows: Array<Record<string, unknown>> | Record<string, unknown>,
  header?: string[],
): Response {
  const array = Array.isArray(rows) ? rows : [rows];
  if (format === "json") return c.json(rows);
  if (format === "csv") return c.body(toCsv(array, header), 200, { "Content-Type": "text/csv; charset=utf-8" });
  return c.body(toXml(root, array), 200, { "Content-Type": "application/xml; charset=utf-8" });
}

function handle(store: Store, form: URLSearchParams, c: AnyContext): Response {
  const tokens = store.getData<string[]>(TOKENS_KEY) ?? [DEFAULT_TOKEN];
  const token = (form.get("token") ?? "").toUpperCase();
  if (!token) throw new ApiError(403, "You do not have permissions to use the API");
  if (!/^[0-9A-F]{32}$/.test(token) || !tokens.includes(token))
    throw new ApiError(403, "You do not have permissions to use the API");
  const content = form.get("content") ?? "";
  const format = (form.get("format") ?? "xml").toLowerCase();
  if (!["json", "csv", "xml"].includes(format))
    throw new ApiError(400, "The format parameter must be json, csv, or xml");
  const p = project(store);
  const action = form.get("action") ?? "export";

  switch (content) {
    case "version":
      return c.body(VERSION, 200, { "Content-Type": "text/html; charset=utf-8" });
    case "project":
      return respond(c, format, "project", p.info);
    case "metadata": {
      const fields = list(form, "fields");
      const forms = list(form, "forms");
      for (const f of fields)
        if (!p.metadata.some((m) => m.field_name === f))
          throw new ApiError(400, `The following values in the parameter fields are not valid: '${f}'`);
      const rows = p.metadata.filter(
        (m) => (!fields.length && !forms.length) || fields.includes(m.field_name) || forms.includes(m.form_name),
      );
      return respond(c, format, "records", rows as unknown as Array<Record<string, unknown>>);
    }
    case "instrument":
      return respond(c, format, "instruments", p.instruments);
    case "exportFieldNames": {
      const only = form.get("field");
      const rows = p.metadata
        .filter((f) => !only || f.field_name === only)
        .flatMap((f) =>
          f.field_type === "checkbox"
            ? choices(f).map((ch) => ({
                original_field_name: f.field_name,
                choice_value: ch.code,
                export_field_name: `${f.field_name}___${ch.code}`,
              }))
            : f.field_type === "descriptive"
              ? []
              : [{ original_field_name: f.field_name, choice_value: "", export_field_name: f.field_name }],
        );
      return respond(c, format, "fields", rows);
    }
    case "generateNextRecordName": {
      const key = p.metadata[0].field_name;
      const next = Math.max(0, ...p.records.map((r) => Number(r[key]) || 0)) + 1;
      return c.body(String(next), 200, { "Content-Type": "text/html; charset=utf-8" });
    }
    case "arm":
    case "event":
      throw new ApiError(400, `You cannot export ${content}s for classic projects`);
    case "record":
      break;
    default:
      throw new ApiError(400, `The value of the parameter "content" is not valid`);
  }

  const key = p.metadata[0].field_name;
  if (action === "delete") {
    const ids = list(form, "records");
    if (!ids.length) throw new ApiError(400, "No records were provided");
    const missing = ids.filter((id) => !p.records.some((r) => r[key] === id));
    if (missing.length)
      throw new ApiError(
        400,
        `One or more of the records provided cannot be deleted because they do not exist in the project. The following records do not exist: ${missing.join(", ")}`,
      );
    p.records = p.records.filter((r) => !ids.includes(r[key]));
    return c.body(String(ids.length), 200, { "Content-Type": "text/html; charset=utf-8" });
  }
  if (action === "import") {
    const raw = form.get("data") ?? "";
    let rows: Row[];
    if (format === "json") {
      try {
        rows = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "The data being imported is not formatted correctly");
      }
    } else if (format === "csv") rows = parseCsv(raw);
    else throw new ApiError(400, "The emulator imports json or csv data");
    if (!Array.isArray(rows)) throw new ApiError(400, "The data being imported is not formatted correctly");
    if (form.get("forceAutoNumber") === "true") {
      let next = Math.max(0, ...p.records.map((r) => Number(r[key]) || 0));
      rows = rows.map((r) => ({ ...r, [key]: String(++next) }));
    }
    const errors = importRecords(p, rows, form.get("overwriteBehavior") ?? "normal");
    if (errors.length) throw new ApiError(400, errors.join("\n"));
    const ids = rows.map((r) => String(r[key]));
    const returnContent = form.get("returnContent") ?? "count";
    if (returnContent === "ids" || returnContent === "auto_ids") return c.json(ids);
    return c.json({ count: ids.length });
  }

  // Export
  const fields = list(form, "fields");
  const forms = list(form, "forms");
  for (const f of fields)
    if (!p.metadata.some((m) => m.field_name === f))
      throw new ApiError(400, `The following values in the parameter fields are not valid: '${f}'`);
  for (const f of forms)
    if (!p.instruments.some((i) => i.instrument_name === f))
      throw new ApiError(400, `The following values in the parameter forms are not valid: '${f}'`);
  const cols = columns(p, fields, forms);
  const ids = list(form, "records");
  const logic = form.get("filterLogic");
  const labels = form.get("rawOrLabel") === "label";
  const byField = new Map(p.metadata.map((m) => [m.field_name, m]));
  let rows = p.records.filter((r) => !ids.length || ids.includes(r[key]));
  if (logic) rows = rows.filter((r) => evaluateLogic(logic, r));
  const out = rows.map((r) =>
    Object.fromEntries(
      cols.map((col) => {
        let v = r[col] ?? "";
        if (labels) {
          const [name, code] = col.split("___");
          const f = byField.get(name);
          if (f && code) v = v === "1" ? (choices(f).find((ch) => ch.code === code)?.label ?? "") : "";
          else if (f) v = choices(f).find((ch) => ch.code === v)?.label ?? v;
          else if (col.endsWith("_complete"))
            v = ({ "0": "Incomplete", "1": "Unverified", "2": "Complete" } as Record<string, string>)[v] ?? v;
        }
        return [col, v];
      }),
    ),
  );
  if ((form.get("type") ?? "flat") === "eav") {
    const eav = out.flatMap((r) =>
      Object.entries(r)
        .filter(([k, v]) => k !== key && v !== "")
        .map(([field_name, value]) => ({ record: r[key], field_name, value })),
    );
    return respond(c, format, "records", eav);
  }
  return respond(c, format, "records", out, cols);
}

export const redcapPlugin: ServicePlugin = {
  name: "redcap",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const api = async (c: AnyContext) => {
      const form = new URLSearchParams(c.req.method === "POST" ? await c.req.text() : "");
      const errorFormat = (form.get("returnFormat") ?? form.get("format") ?? "xml").toLowerCase();
      try {
        if (c.req.method !== "POST") throw new ApiError(400, "The REDCap API only accepts POST requests");
        return handle(store, form, c);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (errorFormat === "json") return c.json({ error: err.message }, err.status as never);
        if (errorFormat === "csv") return c.body(err.message, err.status as never, { "Content-Type": "text/plain" });
        return c.body(
          `<?xml version="1.0" encoding="UTF-8" ?>\n<hash><error>${escapeHtml(err.message)}</error></hash>`,
          err.status as never,
          {
            "Content-Type": "application/xml",
          },
        );
      }
    };
    app.post("/api/", api);
    app.post("/api", api);
    app.get("/api/", api);

    app.get("/_inspector", (c) => {
      const p = project(store);
      const tab = c.req.query("tab") === "dictionary" ? "dictionary" : "records";
      const tabs = [
        { id: "records", label: `Records (${p.records.length})`, href: "/_inspector?tab=records" },
        { id: "dictionary", label: `Data dictionary (${p.metadata.length})`, href: "/_inspector?tab=dictionary" },
      ];
      const head =
        tab === "records" ? columns(p).slice(0, 10) : ["field_name", "form_name", "field_type", "field_label"];
      const rows = (tab === "records" ? p.records.slice(0, 200) : (p.metadata as unknown as Row[])).map(
        (r) => `<tr>${head.map((h) => `<td>${escapeHtml(String(r[h] ?? ""))}</td>`).join("")}</tr>`,
      );
      const html = `<div class="inspector-section"><h2>${escapeHtml(String(p.info.project_title))}</h2><p>POST /api/ with token ${DEFAULT_TOKEN} unless you configure your own.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${head
        .map((h) => `<th>${escapeHtml(h)}</th>`)
        .join("")}</tr></thead><tbody>${
        rows.length
          ? rows.join("")
          : `<tr><td colspan="${head.length}"><div class="inspector-empty">No records</div></td></tr>`
      }</tbody></table></div></div>`;
      return c.html(renderInspectorPage("REDCap inspector", tabs, tab, html, SERVICE_LABEL));
    });
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, generateProject());
  },
};

export default redcapPlugin;
