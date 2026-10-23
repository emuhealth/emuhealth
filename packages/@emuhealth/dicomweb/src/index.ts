import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateInstances, type GenerateOptions } from "./data.js";
import {
  DicomParseError,
  EXPLICIT_VR_LITTLE_ENDIAN,
  grayscalePng,
  readPart10,
  str,
  toDicomJson,
  writePart10,
  type Dataset,
} from "./dicom.js";

export { generateInstances, type GenerateOptions } from "./data.js";
export { readPart10, writePart10, toDicomJson, uidFor, type Dataset, type Element } from "./dicom.js";

/** DICOMweb emulator: QIDO-RS search, WADO-RS retrieve and STOW-RS store over synthetic studies. */
export interface DicomwebSeedConfig {
  port?: number;
  /** Generated studies; false starts empty. */
  generate?: GenerateOptions | false;
  /** Paths of DICOM Part 10 files to load at startup (Explicit or Implicit VR Little Endian). */
  files?: string[];
  /** When set, every DICOMweb request needs Authorization: Bearer <token>. */
  token?: string;
}

interface Instance {
  dataset: Dataset;
  bytes?: Buffer;
}

const DATA_KEY = "dicomweb.instances";
const TOKEN_KEY = "dicomweb.token";
const SERVICE_LABEL = "DICOMweb";
const DICOM_JSON = "application/dicom+json";

function instances(store: Store): Instance[] {
  let list = store.getData<Instance[]>(DATA_KEY);
  if (!list) {
    list = [];
    store.setData(DATA_KEY, list);
  }
  return list;
}

const studyUid = (i: Instance) => str(i.dataset, "0020000D") ?? "";
const seriesUid = (i: Instance) => str(i.dataset, "0020000E") ?? "";
const sopUid = (i: Instance) => str(i.dataset, "00080018") ?? "";
const bytesOf = (i: Instance) => (i.bytes ??= writePart10(i.dataset));

/** Add or replace an instance (matched by SOP Instance UID). */
function put(store: Store, instance: Instance): void {
  const list = instances(store);
  const existing = list.findIndex((i) => sopUid(i) === sopUid(instance));
  if (existing >= 0) list[existing] = instance;
  else list.push(instance);
}

export function seedFromConfig(store: Store, _baseUrl: string, config: DicomwebSeedConfig): void {
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("dicomweb.generate must be an object of generator options or false");
    store.setData(
      DATA_KEY,
      config.generate === false ? [] : generateInstances(config.generate).map((dataset) => ({ dataset })),
    );
  }
  if (config.token !== undefined) {
    if (typeof config.token !== "string" || !config.token) throw new Error("dicomweb.token must be a non-empty string");
    store.setData(TOKEN_KEY, config.token);
  }
  if (config.files === undefined) return;
  if (!Array.isArray(config.files)) throw new Error("dicomweb.files must be an array of paths");
  for (const [n, path] of config.files.entries()) {
    if (typeof path !== "string") throw new Error(`dicomweb.files[${n}] must be a path`);
    const bytes = readFileSync(path);
    let dataset: Dataset;
    try {
      dataset = readPart10(bytes);
    } catch (error) {
      throw new Error(`dicomweb.files[${n}] (${path}): ${(error as Error).message}`);
    }
    if (!str(dataset, "0020000D") || !str(dataset, "0020000E") || !str(dataset, "00080018"))
      throw new Error(`dicomweb.files[${n}] (${path}) has no Study, Series, or SOP Instance UID`);
    put(store, { dataset, bytes });
  }
}

// Attribute keywords accepted in QIDO-RS queries and includefield.
const KEYWORDS: Record<string, string> = {
  SOPClassUID: "00080016",
  SOPInstanceUID: "00080018",
  StudyDate: "00080020",
  StudyTime: "00080030",
  AccessionNumber: "00080050",
  Modality: "00080060",
  ModalitiesInStudy: "00080061",
  ReferringPhysicianName: "00080090",
  StudyDescription: "00081030",
  SeriesDescription: "0008103E",
  PatientName: "00100010",
  PatientID: "00100020",
  PatientBirthDate: "00100030",
  PatientSex: "00100040",
  StudyInstanceUID: "0020000D",
  SeriesInstanceUID: "0020000E",
  StudyID: "00200010",
  SeriesNumber: "00200011",
  InstanceNumber: "00200013",
  Rows: "00280010",
  Columns: "00280011",
  NumberOfFrames: "00280008",
};

type Level = "study" | "series" | "instance";

const LEVEL_TAGS: Record<Level, string[]> = {
  study: [
    "00080020",
    "00080030",
    "00080050",
    "00080090",
    "00081030",
    "00100010",
    "00100020",
    "00100030",
    "00100040",
    "0020000D",
    "00200010",
  ],
  series: ["00080060", "0008103E", "0020000D", "0020000E", "00200011"],
  instance: ["00080016", "00080018", "0020000D", "0020000E", "00200013", "00280008", "00280010", "00280011"],
};

const UID_TAGS = new Set(["00080016", "00080018", "0020000D", "0020000E"]);
const DATE_TAGS = new Set(["00080020", "00100030"]);

function toTag(key: string): string | undefined {
  if (KEYWORDS[key]) return KEYWORDS[key];
  return /^[0-9A-Fa-f]{8}$/.test(key) ? key.toUpperCase() : undefined;
}

function wildcard(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/** Match one attribute value against a QIDO-RS query value (PS3.18 8.3.4.6). */
function matchValue(tag: string, values: string[], query: string, fuzzy: boolean): boolean {
  if (query === "") return true;
  if (UID_TAGS.has(tag)) {
    const wanted = query.split(/[,\\]/);
    return values.some((v) => wanted.includes(v));
  }
  if (DATE_TAGS.has(tag) && query.includes("-")) {
    const [from, to] = query.split("-");
    return values.some((v) => (!from || v >= from) && (!to || v <= to));
  }
  const options = query.split(/[,\\]/);
  return values.some((v) =>
    options.some((q) => {
      if (/[*?]/.test(q)) return wildcard(q).test(v);
      if (tag === "00100010" && fuzzy)
        return v
          .toUpperCase()
          .split(/[\^ ]/)
          .some((part) => part.startsWith(q.toUpperCase()));
      return tag === "00100010" ? v.toUpperCase() === q.toUpperCase() : v === q;
    }),
  );
}

interface Group {
  key: string;
  members: Instance[];
}

function group(list: Instance[], level: Level): Group[] {
  const groups = new Map<string, Instance[]>();
  for (const instance of list) {
    const key = level === "study" ? studyUid(instance) : level === "series" ? seriesUid(instance) : sopUid(instance);
    const members = groups.get(key);
    if (members) members.push(instance);
    else groups.set(key, [instance]);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, members }));
}

const asStrings = (ds: Dataset, tag: string): string[] => {
  const v = ds.get(tag)?.value;
  return Array.isArray(v) ? v.map(String) : [];
};

/** Values of an attribute for a group, including the computed study and series attributes. */
function groupValues(g: Group, tag: string, all: Instance[]): string[] {
  if (tag === "00080061")
    return [
      ...new Set(
        all.filter((i) => studyUid(i) === studyUid(g.members[0])).map((i) => str(i.dataset, "00080060") ?? ""),
      ),
    ];
  return asStrings(g.members[0].dataset, tag);
}

function urls(baseUrl: string, i: Instance) {
  const study = `${baseUrl}/studies/${studyUid(i)}`;
  const series = `${study}/series/${seriesUid(i)}`;
  return { study, series, instance: `${series}/instances/${sopUid(i)}` };
}

function describe(g: Group, level: Level, all: Instance[], include: string[], includeAll: boolean, baseUrl: string) {
  const first = g.members[0];
  const ds = first.dataset;
  const tags = new Set([...LEVEL_TAGS[level], ...include]);
  if (level !== "study") for (const t of LEVEL_TAGS.study) if (include.includes(t)) tags.add(t);
  const picked: Dataset = new Map();
  if (level === "instance" && includeAll) for (const [t, e] of ds) picked.set(t, e);
  for (const t of tags) {
    const e = ds.get(t);
    if (e) picked.set(t, e);
  }
  const out = toDicomJson(picked);
  const u = urls(baseUrl, first);
  if (level === "study") {
    const studyMembers = all.filter((i) => studyUid(i) === g.key);
    out["00080061"] = { vr: "CS", Value: groupValues(g, "00080061", all) };
    out["00201206"] = { vr: "IS", Value: [new Set(studyMembers.map(seriesUid)).size] };
    out["00201208"] = { vr: "IS", Value: [studyMembers.length] };
    out["00081190"] = { vr: "UR", Value: [u.study] };
  } else if (level === "series") {
    out["00201209"] = { vr: "IS", Value: [g.members.length] };
    out["00081190"] = { vr: "UR", Value: [u.series] };
  } else out["00081190"] = { vr: "UR", Value: [u.instance] };
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function errorBody(c: Context<AppEnv>, status: 400 | 401 | 404 | 406 | 409 | 415, message: string) {
  return c.json({ error: message }, status);
}

/** Whether an Accept header allows a multipart/related response of the given part type. */
function acceptsMultipart(accept: string | undefined, partType: string): boolean {
  if (!accept) return true;
  return accept.split(",").some((range) => {
    const [media, ...params] = range.split(";").map((p) => p.trim());
    if (media === "*/*") return true;
    if (media.toLowerCase() !== "multipart/related") return false;
    const map = Object.fromEntries(
      params.map((p) => {
        const [k, v = ""] = p.split("=");
        return [k.trim().toLowerCase(), v.trim().replace(/^"|"$/g, "")];
      }),
    );
    if (map.type && map.type !== partType && map.type !== "*/*") return false;
    const syntax = map["transfer-syntax"];
    return !syntax || syntax === "*" || syntax === EXPLICIT_VR_LITTLE_ENDIAN || partType !== "application/dicom";
  });
}

function multipart(c: Context<AppEnv>, partType: string, parts: Array<{ bytes: Buffer; location?: string }>) {
  const boundary = `emuhealth-${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const headers = [`--${boundary}`, `Content-Type: ${partType}`];
    if (part.location) headers.push(`Content-Location: ${part.location}`);
    chunks.push(Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "latin1"), part.bytes, Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return c.body(new Uint8Array(Buffer.concat(chunks)), 200, {
    "Content-Type": `multipart/related; type="${partType}"; boundary=${boundary}`,
  });
}

/** Split a multipart/related body into its part bodies. */
function parseMultipart(body: Buffer, boundary: string): Array<{ headers: Record<string, string>; body: Buffer }> {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const parts: Array<{ headers: Record<string, string>; body: Buffer }> = [];
  let pos = body.indexOf(delimiter);
  while (pos >= 0) {
    pos += delimiter.length;
    if (body.toString("latin1", pos, pos + 2) === "--") break;
    const headerEnd = body.indexOf("\r\n\r\n", pos, "latin1");
    if (headerEnd < 0) break;
    const headers: Record<string, string> = {};
    for (const line of body.toString("latin1", pos, headerEnd).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
    parts.push({ headers, body: body.subarray(headerEnd + 4, end) });
    pos = next;
  }
  return parts;
}

function contentTypeParams(header: string): { media: string; params: Record<string, string> } {
  const [media, ...rest] = header.split(";").map((p) => p.trim());
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0)
      params[p.slice(0, eq).trim().toLowerCase()] = p
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
  }
  return { media: media.toLowerCase(), params };
}

interface Frames {
  frames: Buffer[];
  rows: number;
  columns: number;
  bits: number;
  signed: boolean;
  photometric: string;
  samples: number;
}

function framesOf(ds: Dataset): Frames | undefined {
  const pixels = ds.get("7FE00010")?.value;
  if (!(pixels instanceof Uint8Array)) return undefined;
  const num = (tag: string, fallback: number) => Number(asStrings(ds, tag)[0] ?? fallback);
  const rows = num("00280010", 0);
  const columns = num("00280011", 0);
  const bits = num("00280100", 8);
  const samples = num("00280002", 1);
  const count = num("00280008", 1) || 1;
  const size = (rows * columns * samples * bits) / 8;
  if (!size) return undefined;
  const all = Buffer.from(pixels);
  const frames = Array.from({ length: count }, (_, n) => all.subarray(n * size, (n + 1) * size));
  return {
    frames,
    rows,
    columns,
    bits,
    samples,
    signed: num("00280103", 0) === 1,
    photometric: str(ds, "00280004") ?? "MONOCHROME2",
  };
}

/** Render a grayscale frame to PNG, scaling the stored range to 8 bits. */
function renderFrame(f: Frames, frame: Buffer): Buffer | undefined {
  if (f.samples !== 1 || !f.photometric.startsWith("MONOCHROME") || (f.bits !== 8 && f.bits !== 16)) return undefined;
  const count = f.rows * f.columns;
  const raw = new Float64Array(count);
  for (let i = 0; i < count; i++)
    raw[i] =
      f.bits === 8
        ? f.signed
          ? frame.readInt8(i)
          : frame[i]
        : f.signed
          ? frame.readInt16LE(i * 2)
          : frame.readUInt16LE(i * 2);
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const v = Math.round(((raw[i] - min) / span) * 255);
    out[i] = f.photometric === "MONOCHROME1" ? 255 - v : v;
  }
  return grayscalePng(out, f.columns, f.rows, deflateSync);
}

function inspector(store: Store): string {
  const all = instances(store);
  const rows = group(all, "study")
    .slice(0, 200)
    .map((g) => {
      const ds = g.members[0].dataset;
      const thumb = `/studies/${g.key}/series/${seriesUid(g.members[0])}/instances/${sopUid(g.members[0])}/rendered`;
      const modalities = [...new Set(g.members.map((i) => str(i.dataset, "00080060") ?? ""))].join(", ");
      return `<tr><td><img src="${escapeAttr(thumb)}" width="48" height="48" alt=""></td><td><a href="${escapeAttr(`/studies/${g.key}/metadata`)}">${escapeHtml(g.key)}</a></td><td>${escapeHtml(str(ds, "00100020") ?? "")}</td><td>${escapeHtml((str(ds, "00100010") ?? "").replace(/\^/g, " "))}</td><td>${escapeHtml(str(ds, "00080020") ?? "")}</td><td>${escapeHtml(modalities)}</td><td>${escapeHtml(str(ds, "00081030") ?? "")}</td><td>${new Set(g.members.map(seriesUid)).size}</td><td>${g.members.length}</td></tr>`;
    });
  const body = `<div class="inspector-section"><h2>Studies</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th></th><th>study UID</th><th>patient ID</th><th>patient name</th><th>date</th><th>modalities</th><th>description</th><th>series</th><th>instances</th></tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="9"><div class="inspector-empty">No studies</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage(
    "DICOMweb inspector",
    [{ id: "studies", label: `Studies (${group(all, "study").length})`, href: "/_inspector" }],
    "studies",
    body,
    SERVICE_LABEL,
  );
}

export const dicomwebPlugin: ServicePlugin = {
  name: "dicomweb",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const base = baseUrl.replace(/\/$/, "");

    app.use("/:rest{(studies|series|instances)(/.*)?}", async (c, next) => {
      const token = store.getData<string>(TOKEN_KEY);
      if (token && c.req.header("authorization") !== `Bearer ${token}`)
        return c.json({ error: "Missing or invalid bearer token" }, 401, { "WWW-Authenticate": "Bearer" });
      await next();
    });

    const select = (study?: string, series?: string, instance?: string) =>
      instances(store).filter(
        (i) =>
          (!study || studyUid(i) === study) &&
          (!series || seriesUid(i) === series) &&
          (!instance || sopUid(i) === instance),
      );

    // QIDO-RS
    const search = (level: Level) => (c: Context<AppEnv>) => {
      const study = c.req.param("study");
      const series = c.req.param("series");
      const params = new URL(c.req.url).searchParams;
      const include: string[] = [];
      let includeAll = false;
      for (const value of params.getAll("includefield"))
        for (const field of value.split(",")) {
          if (field === "all") includeAll = true;
          else {
            const tag = toTag(field);
            if (!tag) return errorBody(c, 400, `Unknown includefield ${field}`);
            include.push(tag);
          }
        }
      const fuzzy = params.get("fuzzymatching") === "true";
      const filters: Array<[string, string]> = [];
      for (const [key, value] of params) {
        if (["includefield", "fuzzymatching", "limit", "offset"].includes(key)) continue;
        const tag = toTag(key);
        if (!tag) return errorBody(c, 400, `Unsupported query attribute ${key}`);
        filters.push([tag, value]);
      }
      const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
      const offset = Number(params.get("offset") ?? 0);
      if ((limit !== undefined && (!Number.isInteger(limit) || limit < 0)) || !Number.isInteger(offset) || offset < 0)
        return errorBody(c, 400, "limit and offset must be non-negative integers");
      const all = instances(store);
      const scoped = select(study, series);
      if (study && !scoped.length && level !== "study") return errorBody(c, 404, `Study ${study} not found`);
      const matched = group(scoped, level).filter((g) =>
        filters.every(([tag, value]) => {
          // Lower level attributes match when any member matches.
          if (tag === "00080061") return matchValue(tag, groupValues(g, tag, all), value, fuzzy);
          return g.members.some((m) => matchValue(tag, asStrings(m.dataset, tag), value, fuzzy));
        }),
      );
      const page = matched.slice(offset, limit === undefined ? undefined : offset + limit);
      return c.json(
        page.map((g) => describe(g, level, all, include, includeAll, base)),
        200,
        { "Content-Type": DICOM_JSON },
      );
    };
    app.get("/studies", search("study"));
    app.get("/series", search("series"));
    app.get("/instances", search("instance"));
    app.get("/studies/:study/series", search("series"));
    app.get("/studies/:study/instances", search("instance"));
    app.get("/studies/:study/series/:series/instances", search("instance"));

    // WADO-RS metadata
    const metadata = (c: Context<AppEnv>) => {
      const found = select(c.req.param("study"), c.req.param("series"), c.req.param("instance"));
      if (!found.length) return errorBody(c, 404, "Not found");
      return c.json(
        found.map((i) => toDicomJson(i.dataset, `${urls(base, i).instance}/bulkdata/7FE00010`)),
        200,
        { "Content-Type": DICOM_JSON },
      );
    };
    app.get("/studies/:study/metadata", metadata);
    app.get("/studies/:study/series/:series/metadata", metadata);
    app.get("/studies/:study/series/:series/instances/:instance/metadata", metadata);

    // WADO-RS rendered
    const rendered = (c: Context<AppEnv>) => {
      const [instance] = select(c.req.param("study"), c.req.param("series"), c.req.param("instance"));
      if (!instance) return errorBody(c, 404, "Not found");
      const accept = c.req.header("accept");
      if (accept && !/image\/png|image\/\*|\*\/\*/i.test(accept))
        return errorBody(c, 406, "Only image/png is rendered");
      const f = framesOf(instance.dataset);
      const n = Number(c.req.param("frame") || 1);
      const frame = f?.frames[n - 1];
      if (!f || !frame) return errorBody(c, 404, "Frame not found");
      const png = renderFrame(f, frame);
      if (!png) return errorBody(c, 406, "Only 8 or 16 bit grayscale images are rendered");
      return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png" });
    };
    for (const suffix of ["rendered", "thumbnail", "frames/:frame{[0-9]+}/rendered", "frames/:frame{[0-9]+}/thumbnail"])
      app.get(`/studies/:study/series/:series/instances/:instance/${suffix}`, rendered);

    // WADO-RS frames and bulk data
    app.get("/studies/:study/series/:series/instances/:instance/frames/:frames", (c) => {
      const [instance] = select(c.req.param("study"), c.req.param("series"), c.req.param("instance"));
      if (!instance) return errorBody(c, 404, "Not found");
      if (!acceptsMultipart(c.req.header("accept"), "application/octet-stream"))
        return errorBody(c, 406, 'Frames are returned as multipart/related; type="application/octet-stream"');
      const f = framesOf(instance.dataset);
      const wanted = c.req.param("frames").split(",").map(Number);
      if (!f || wanted.some((n) => !Number.isInteger(n) || n < 1 || n > f.frames.length))
        return errorBody(c, 404, "Frame not found");
      return multipart(
        c,
        "application/octet-stream",
        wanted.map((n) => ({ bytes: f.frames[n - 1] })),
      );
    });
    app.get("/studies/:study/series/:series/instances/:instance/bulkdata/:tag", (c) => {
      const [instance] = select(c.req.param("study"), c.req.param("series"), c.req.param("instance"));
      const value = instance?.dataset.get(c.req.param("tag").toUpperCase())?.value;
      if (!(value instanceof Uint8Array)) return errorBody(c, 404, "Bulk data not found");
      if (!acceptsMultipart(c.req.header("accept"), "application/octet-stream"))
        return errorBody(c, 406, 'Bulk data is returned as multipart/related; type="application/octet-stream"');
      return multipart(c, "application/octet-stream", [{ bytes: Buffer.from(value) }]);
    });

    // WADO-RS instances
    const retrieve = (c: Context<AppEnv>) => {
      const found = select(c.req.param("study"), c.req.param("series"), c.req.param("instance"));
      if (!found.length) return errorBody(c, 404, "Not found");
      if (!acceptsMultipart(c.req.header("accept"), "application/dicom"))
        return errorBody(
          c,
          406,
          'Instances are returned as multipart/related; type="application/dicom" in their stored transfer syntax',
        );
      return multipart(
        c,
        "application/dicom",
        found.map((i) => ({ bytes: bytesOf(i), location: urls(base, i).instance })),
      );
    };
    app.get("/studies/:study", retrieve);
    app.get("/studies/:study/series/:series", retrieve);
    app.get("/studies/:study/series/:series/instances/:instance", retrieve);

    // STOW-RS
    const stow = async (c: Context<AppEnv>) => {
      const target = c.req.param("study") || undefined;
      const { media, params } = contentTypeParams(c.req.header("content-type") ?? "");
      if (media !== "multipart/related" || !params.boundary || (params.type && params.type !== "application/dicom"))
        return errorBody(c, 415, 'STOW-RS takes multipart/related; type="application/dicom" with a boundary');
      const parts = parseMultipart(Buffer.from(await c.req.arrayBuffer()), params.boundary);
      if (!parts.length) return errorBody(c, 400, "The request has no parts");
      const stored: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];
      const studies = new Set<string>();
      for (const part of parts) {
        const partType = (part.headers["content-type"] ?? "application/dicom").split(";")[0].trim().toLowerCase();
        let dataset: Dataset | undefined;
        let reason: number | undefined;
        if (partType !== "application/dicom") reason = 0xc000;
        else
          try {
            dataset = readPart10(part.body);
          } catch (error) {
            if (!(error instanceof DicomParseError) && !(error instanceof RangeError)) throw error;
            reason = 0xc000;
          }
        const sopClass = dataset ? str(dataset, "00080016") : undefined;
        const sop = dataset ? str(dataset, "00080018") : undefined;
        if (dataset && (!sopClass || !sop || !str(dataset, "0020000D") || !str(dataset, "0020000E"))) reason = 0xa900;
        else if (dataset && target && str(dataset, "0020000D") !== target) reason = 0xa900;
        if (reason !== undefined || !dataset) {
          const entry: Record<string, unknown> = { "00081197": { vr: "US", Value: [reason ?? 0xc000] } };
          if (sopClass) entry["00081150"] = { vr: "UI", Value: [sopClass] };
          if (sop) entry["00081155"] = { vr: "UI", Value: [sop] };
          failed.push(entry);
          continue;
        }
        const instance: Instance = { dataset, bytes: Buffer.from(part.body) };
        put(store, instance);
        studies.add(studyUid(instance));
        stored.push({
          "00081150": { vr: "UI", Value: [sopClass] },
          "00081155": { vr: "UI", Value: [sop] },
          "00081190": { vr: "UR", Value: [urls(base, instance).instance] },
        });
      }
      const response: Record<string, unknown> = {};
      const retrieveStudy = target ?? (studies.size === 1 ? [...studies][0] : undefined);
      if (retrieveStudy && stored.length)
        response["00081190"] = { vr: "UR", Value: [`${base}/studies/${retrieveStudy}`] };
      if (failed.length) response["00081198"] = { vr: "SQ", Value: failed };
      if (stored.length) response["00081199"] = { vr: "SQ", Value: stored };
      const status = failed.length === 0 ? 200 : stored.length === 0 ? 409 : 202;
      return c.json(response, status, { "Content-Type": DICOM_JSON });
    };
    app.post("/studies", stow);
    app.post("/studies/:study", stow);

    // Deletion, as offered by most DICOMweb servers.
    const remove = (c: Context<AppEnv>) => {
      const doomed = new Set(select(c.req.param("study"), c.req.param("series"), c.req.param("instance")));
      if (!doomed.size) return errorBody(c, 404, "Not found");
      store.setData(
        DATA_KEY,
        instances(store).filter((i) => !doomed.has(i)),
      );
      return c.body(null, 204);
    };
    app.delete("/studies/:study", remove);
    app.delete("/studies/:study/series/:series", remove);
    app.delete("/studies/:study/series/:series/instances/:instance", remove);

    app.get("/_inspector", (c) => c.html(inspector(store)));
  },
  seed(store: Store): void {
    store.setData(
      DATA_KEY,
      generateInstances().map((dataset) => ({ dataset })),
    );
  },
};

export default dicomwebPlugin;
