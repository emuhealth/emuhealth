import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateStudies, type GenerateOptions, type Study } from "./data.js";

export { generateStudies, STATUSES, type GenerateOptions, type Study } from "./data.js";

/**
 * ClinicalTrials.gov API v2 emulator: /api/v2/studies search with query, filter, sort, fields, and page tokens,
 * single studies, version, and stats, over deterministic synthetic studies in the NCT99 range.
 */
export interface ClinicalTrialsSeedConfig {
  port?: number;
  /** Generated studies; false starts empty. */
  generate?: GenerateOptions | false;
  /** Extra synthetic studies in the API v2 shape (protocolSection.identificationModule.nctId is required). */
  studies?: Study[];
}

const DATA_KEY = "clinicaltrials.studies";
const API = "/api/v2";
const SERVICE_LABEL = "ClinicalTrials.gov";

const ALL_STATUSES = [
  "ACTIVE_NOT_RECRUITING",
  "COMPLETED",
  "ENROLLING_BY_INVITATION",
  "NOT_YET_RECRUITING",
  "RECRUITING",
  "SUSPENDED",
  "TERMINATED",
  "WITHDRAWN",
  "AVAILABLE",
  "NO_LONGER_AVAILABLE",
  "TEMPORARILY_NOT_AVAILABLE",
  "APPROVED_FOR_MARKETING",
  "WITHHELD",
  "UNKNOWN",
];

const P = "protocolSection";
/** Field piece names (as the fields, sort, and AREA[] syntax use them) and the paths they read. */
export const PIECES: Record<string, string> = {
  NCTId: `${P}.identificationModule.nctId`,
  OrgStudyId: `${P}.identificationModule.orgStudyIdInfo.id`,
  OrgFullName: `${P}.identificationModule.organization.fullName`,
  BriefTitle: `${P}.identificationModule.briefTitle`,
  OfficialTitle: `${P}.identificationModule.officialTitle`,
  OverallStatus: `${P}.statusModule.overallStatus`,
  WhyStopped: `${P}.statusModule.whyStopped`,
  StartDate: `${P}.statusModule.startDateStruct.date`,
  PrimaryCompletionDate: `${P}.statusModule.primaryCompletionDateStruct.date`,
  CompletionDate: `${P}.statusModule.completionDateStruct.date`,
  StudyFirstSubmitDate: `${P}.statusModule.studyFirstSubmitDate`,
  LastUpdatePostDate: `${P}.statusModule.lastUpdatePostDateStruct.date`,
  LeadSponsorName: `${P}.sponsorCollaboratorsModule.leadSponsor.name`,
  LeadSponsorClass: `${P}.sponsorCollaboratorsModule.leadSponsor.class`,
  BriefSummary: `${P}.descriptionModule.briefSummary`,
  Condition: `${P}.conditionsModule.conditions`,
  Keyword: `${P}.conditionsModule.keywords`,
  StudyType: `${P}.designModule.studyType`,
  Phase: `${P}.designModule.phases`,
  EnrollmentCount: `${P}.designModule.enrollmentInfo.count`,
  InterventionType: `${P}.armsInterventionsModule.interventions.type`,
  InterventionName: `${P}.armsInterventionsModule.interventions.name`,
  PrimaryOutcomeMeasure: `${P}.outcomesModule.primaryOutcomes.measure`,
  EligibilityCriteria: `${P}.eligibilityModule.eligibilityCriteria`,
  HealthyVolunteers: `${P}.eligibilityModule.healthyVolunteers`,
  Sex: `${P}.eligibilityModule.sex`,
  MinimumAge: `${P}.eligibilityModule.minimumAge`,
  MaximumAge: `${P}.eligibilityModule.maximumAge`,
  StdAge: `${P}.eligibilityModule.stdAges`,
  LocationFacility: `${P}.contactsLocationsModule.locations.facility`,
  LocationCity: `${P}.contactsLocationsModule.locations.city`,
  LocationState: `${P}.contactsLocationsModule.locations.state`,
  LocationZip: `${P}.contactsLocationsModule.locations.zip`,
  LocationCountry: `${P}.contactsLocationsModule.locations.country`,
  LocationStatus: `${P}.contactsLocationsModule.locations.status`,
  HasResults: "hasResults",
};

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function studies(store: Store): Study[] {
  let list = store.getData<Study[]>(DATA_KEY);
  if (!list) {
    list = [];
    store.setData(DATA_KEY, list);
  }
  return list;
}

const nctId = (study: Study) => String(valuesAt(study, PIECES.NCTId)[0] ?? "");

export function seedFromConfig(store: Store, _baseUrl: string, config: ClinicalTrialsSeedConfig): void {
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("clinicaltrials.generate must be an object of generator options or false");
    store.setData(DATA_KEY, config.generate === false ? [] : generateStudies(config.generate));
  }
  if (config.studies === undefined) return;
  if (!Array.isArray(config.studies)) throw new Error("clinicaltrials.studies must be an array");
  const list = studies(store);
  for (const [i, study] of config.studies.entries()) {
    if (!/^NCT\d{8}$/.test(nctId(study)))
      throw new Error(`clinicaltrials.studies[${i}] needs protocolSection.identificationModule.nctId like NCT99000001`);
    const existing = list.findIndex((s) => nctId(s) === nctId(study));
    if (existing >= 0) list[existing] = study;
    else list.push(study);
  }
}

/** Primitive values at a dotted path, through arrays. */
export function valuesAt(value: unknown, path: string): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, parts: string[]) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, parts));
    if (parts.length === 0) return void (typeof v !== "object" && out.push(v));
    if (typeof v === "object") walk((v as Record<string, unknown>)[parts[0]], parts.slice(1));
  };
  walk(value, path.split("."));
  return out;
}

/** The parts of a study at the given paths, keeping their nesting. */
function project(study: Study, paths: string[]): Study {
  const pick = (value: unknown, parts: string[]): unknown => {
    if (value === undefined || value === null) return undefined;
    if (parts.length === 0) return value;
    if (Array.isArray(value)) {
      const items = value.map((v) => pick(v, parts)).filter((v) => v !== undefined);
      return items.length ? items : undefined;
    }
    if (typeof value !== "object") return undefined;
    const child = pick((value as Record<string, unknown>)[parts[0]], parts.slice(1));
    return child === undefined ? undefined : { [parts[0]]: child };
  };
  const merge = (a: unknown, b: unknown): unknown => {
    if (a === undefined) return b;
    if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object") {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
      return out;
    }
    return a;
  };
  return paths.reduce<unknown>((acc, path) => merge(acc, pick(study, path.split("."))), {}) as Study;
}

function fieldPaths(fields: string | undefined): string[] | undefined {
  if (!fields) return undefined;
  return fields
    .split(/[,|]/)
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => {
      if (PIECES[f]) return PIECES[f];
      if (f === P || f.startsWith(`${P}.`) || f === "hasResults") return f;
      throw new ApiError(400, `Parameter 'fields' contains invalid field name: '${f}'`);
    });
}

function allValues(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => allValues(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allValues(v, out));
  else if (value !== undefined && value !== null) out.push(value);
  return out;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Essie-style text match: OR between alternatives, every word of an alternative must appear. */
function textMatch(values: unknown[], query: string): boolean {
  const haystack = new Set(values.flatMap((v) => words(String(v))));
  return query
    .split(/\s+OR\s+/)
    .some((alternative) => words(alternative.replace(/\bAND\b/g, " ")).every((w) => haystack.has(w)));
}

const textOf = (study: Study, pieces: string[]) => pieces.flatMap((p) => valuesAt(study, PIECES[p]));

const QUERIES: Record<string, (study: Study) => unknown[]> = {
  "query.cond": (s) => textOf(s, ["Condition", "Keyword", "BriefTitle", "OfficialTitle"]),
  "query.term": (s) => allValues(s),
  "query.intr": (s) => textOf(s, ["InterventionName", "InterventionType"]),
  "query.titles": (s) => textOf(s, ["BriefTitle", "OfficialTitle"]),
  "query.outc": (s) => textOf(s, ["PrimaryOutcomeMeasure"]),
  "query.spons": (s) => textOf(s, ["LeadSponsorName", "OrgFullName"]),
  "query.locn": (s) =>
    textOf(s, ["LocationFacility", "LocationCity", "LocationState", "LocationZip", "LocationCountry"]),
  "query.id": (s) => textOf(s, ["NCTId", "OrgStudyId"]),
};

/** filter.advanced with AREA[Piece]value clauses joined by AND. */
function advancedMatch(study: Study, expression: string): boolean {
  return expression.split(/\s+AND\s+/).every((clause) => {
    const area = /^AREA\[(\w+)\](.+)$/.exec(clause.trim());
    if (!area || !PIECES[area[1]]) throw new ApiError(400, `Unsupported filter.advanced expression: ${clause}`);
    const wanted = area[2].replace(/^"|"$/g, "").toLowerCase();
    return valuesAt(study, PIECES[area[1]]).some((v) => String(v).toLowerCase() === wanted);
  });
}

function search(all: Study[], params: URLSearchParams) {
  let hits = all;
  for (const [name, read] of Object.entries(QUERIES)) {
    const value = params.get(name);
    if (value) hits = hits.filter((s) => textMatch(read(s), value));
  }
  const statuses = params.get("filter.overallStatus");
  if (statuses) {
    const wanted = statuses.split(/[,|]/).map((s) => s.trim());
    for (const status of wanted)
      if (!ALL_STATUSES.includes(status))
        throw new ApiError(400, `Invalid value in parameter \`overallStatus\`: \`${status}\``);
    hits = hits.filter((s) => wanted.includes(String(valuesAt(s, PIECES.OverallStatus)[0])));
  }
  const ids = params.get("filter.ids");
  if (ids) {
    const wanted = ids.split(/[,|]/).map((s) => s.trim());
    hits = hits.filter((s) => wanted.includes(nctId(s)));
  }
  const advanced = params.get("filter.advanced");
  if (advanced) hits = hits.filter((s) => advancedMatch(s, advanced));
  const sort = params.get("sort");
  if (sort && sort !== "@relevance") {
    const keys = sort.split(",").map((part) => {
      const [piece, direction = "asc"] = part.trim().split(":");
      if (!PIECES[piece]) throw new ApiError(400, `Parameter 'sort' contains invalid field name: '${piece}'`);
      if (direction !== "asc" && direction !== "desc")
        throw new ApiError(400, `Parameter 'sort' has invalid direction: '${direction}'`);
      return { path: PIECES[piece], desc: direction === "desc" };
    });
    hits = [...hits].sort((a, b) => {
      for (const key of keys) {
        const order = String(valuesAt(a, key.path)[0] ?? "").localeCompare(
          String(valuesAt(b, key.path)[0] ?? ""),
          undefined,
          {
            numeric: true,
          },
        );
        if (order !== 0) return key.desc ? -order : order;
      }
      return 0;
    });
  }
  return hits;
}

const pageToken = (offset: number) => Buffer.from(`emuhealth:${offset}`).toString("base64url");
function readPageToken(token: string): number {
  const match = /^emuhealth:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
  if (!match) throw new ApiError(400, "Parameter `pageToken` is invalid");
  return Number(match[1]);
}

function text(c: Context<AppEnv>, status: number, message: string): Response {
  return c.body(message, status as never, { "Content-Type": "text/plain; charset=UTF-8" });
}

function inspector(store: Store): string {
  const rows = studies(store)
    .slice(0, 200)
    .map((s) => {
      const id = nctId(s);
      const cell = (piece: string) => escapeHtml(valuesAt(s, PIECES[piece]).join(", "));
      return `<tr><td><a href="${escapeAttr(`${API}/studies/${id}`)}">${escapeHtml(id)}</a></td><td>${cell("BriefTitle")}</td><td>${cell("OverallStatus")}</td><td>${cell("Phase")}</td><td>${cell("LeadSponsorName")}</td></tr>`;
    });
  const body = `<div class="inspector-section"><h2>Studies</h2>
<div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>NCT id</th><th>title</th><th>status</th><th>phase</th><th>sponsor</th></tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="5"><div class="inspector-empty">No studies</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage(
    "ClinicalTrials.gov inspector",
    [{ id: "studies", label: `Studies (${studies(store).length})`, href: "/_inspector" }],
    "studies",
    body,
    SERVICE_LABEL,
  );
}

export const clinicaltrialsPlugin: ServicePlugin = {
  name: "clinicaltrials",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const handle = (c: Context<AppEnv>, run: () => Response) => {
      try {
        const format = c.req.query("format");
        if (format && format !== "json") throw new ApiError(400, "The emulator only returns format=json");
        return run();
      } catch (err) {
        if (err instanceof ApiError) return text(c, err.status, err.message);
        throw err;
      }
    };

    app.get(`${API}/version`, (c) => c.json({ apiVersion: "2.0.5", dataTimestamp: "2026-01-01T00:00:00" }));

    app.get(`${API}/stats/size`, (c) => c.json({ totalStudies: studies(store).length }));

    app.get(`${API}/studies`, (c) =>
      handle(c, () => {
        const params = new URL(c.req.url).searchParams;
        const hits = search(studies(store), params);
        const rawSize = params.get("pageSize");
        const size = rawSize === null ? 10 : Number(rawSize);
        if (!Number.isInteger(size) || size < 0)
          throw new ApiError(400, "Parameter `pageSize` must be a non-negative integer");
        const pageSize = Math.min(size, 1000);
        const token = params.get("pageToken");
        const offset = token ? readPageToken(token) : 0;
        const paths = fieldPaths(params.get("fields") ?? undefined);
        const page = hits.slice(offset, offset + pageSize).map((s) => (paths ? project(s, paths) : s));
        return c.json({
          ...(params.get("countTotal") === "true" ? { totalCount: hits.length } : {}),
          studies: page,
          ...(offset + pageSize < hits.length ? { nextPageToken: pageToken(offset + pageSize) } : {}),
        });
      }),
    );

    app.get(`${API}/studies/:nctId`, (c) =>
      handle(c, () => {
        const id = c.req.param("nctId");
        if (!/^NCT\d{8}$/.test(id)) throw new ApiError(400, "Parameter `nctId` has incorrect format");
        const study = studies(store).find((s) => nctId(s) === id);
        if (!study) throw new ApiError(404, `NCT number ${id} not found`);
        const paths = fieldPaths(c.req.query("fields"));
        return c.json(paths ? project(study, paths) : study);
      }),
    );

    app.get("/_inspector", (c) => c.html(inspector(store)));
    app.get("/:rest{(?!_emulate).*}", (c) => text(c, 404, "Not found"));
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, generateStudies());
  },
};

export default clinicaltrialsPlugin;
