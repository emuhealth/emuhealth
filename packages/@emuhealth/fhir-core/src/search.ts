import { FhirError } from "./outcome.js";
import { searchParamsFor, type SearchParamDefinition } from "./search-params.js";
import type { FhirResource } from "./store.js";

/** Search parameters that control the result set rather than filter it. */
const RESULT_PARAMS = new Set(["_count", "_sort", "_summary", "_total", "_getpagesoffset", "_format", "_pretty"]);

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

type Range = { start: number; end: number };

interface Criterion {
  definition: SearchParamDefinition;
  modifier?: string;
  /** Comma separated values: any of them may match. */
  values: string[];
  /** The original "name[:modifier]" key, kept for the self link. */
  key: string;
  raw: string;
  /** Chained search (for example patient.family): the rest of the key, evaluated on the referenced resource. */
  chain?: { targetType?: string; key: string };
}

/** An _include or _revinclude directive: SourceType:param[:TargetType][:iterate]. */
export interface IncludeDirective {
  source: string;
  definition: SearchParamDefinition;
  target?: string;
  iterate: boolean;
}

/** Read access to the store that chained search and includes need. */
export interface SearchContext {
  resolve(type: string, id: string): FhirResource | undefined;
  listCurrent(type: string): FhirResource[];
}

export interface ParsedSearch {
  criteria: Criterion[];
  sort: Array<{ definition: SearchParamDefinition; descending: boolean }>;
  count: number;
  offset: number;
  summaryCount: boolean;
  includes: IncludeDirective[];
  revincludes: IncludeDirective[];
  /** Query parameters the server applied, in a stable order, for Bundle links. */
  applied: Array<[string, string]>;
}

export interface SearchOptions {
  /** Prefer: handling=strict rejects unknown parameters instead of ignoring them. */
  strict?: boolean;
}

function splitValues(raw: string): string[] {
  // Commas escaped as "\," belong to the value.
  return raw
    .split(/(?<!\\),/)
    .map((v) => v.replace(/\\,/g, ","))
    .filter((v) => v.length > 0);
}

function parseNonNegative(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new FhirError(400, "value", `Invalid ${name} value "${value}"`);
  return Number(value);
}

export function parseSearch(type: string, params: Array<[string, string]>, options: SearchOptions = {}): ParsedSearch {
  const definitions = searchParamsFor(type);
  const parsed: ParsedSearch = {
    criteria: [],
    sort: [],
    count: DEFAULT_PAGE_SIZE,
    offset: 0,
    summaryCount: false,
    includes: [],
    revincludes: [],
    applied: [],
  };
  for (const [key, raw] of params) {
    if (RESULT_PARAMS.has(key)) {
      if (key === "_count") parsed.count = Math.min(parseNonNegative(key, raw), MAX_PAGE_SIZE);
      else if (key === "_getpagesoffset") parsed.offset = parseNonNegative(key, raw);
      else if (key === "_summary" && raw === "count") parsed.summaryCount = true;
      else if (key === "_sort") {
        for (const field of raw.split(",").filter(Boolean)) {
          const descending = field.startsWith("-");
          const definition = definitions.get(descending ? field.slice(1) : field);
          if (!definition || definition.type === "reference") {
            if (options.strict) throw new FhirError(400, "not-supported", `Cannot sort ${type} by "${field}"`);
            continue;
          }
          parsed.sort.push({ definition, descending });
        }
      }
      if (key === "_count" || key === "_sort" || key === "_summary") parsed.applied.push([key, raw]);
      continue;
    }
    if (key === "_include" || key === "_revinclude" || key === "_include:iterate" || key === "_revinclude:iterate") {
      const directive = parseInclude(raw, key.endsWith(":iterate"));
      if (!directive || (key.startsWith("_include") && !directive.iterate && directive.source !== type)) {
        if (options.strict) throw new FhirError(400, "not-supported", `Unsupported ${key} value "${raw}"`);
        continue;
      }
      (key.startsWith("_include") ? parsed.includes : parsed.revincludes).push(directive);
      parsed.applied.push([key, raw]);
      continue;
    }
    const dot = key.indexOf(".");
    if (dot > 0) {
      const [name, targetType] = key.slice(0, dot).split(":", 2);
      const definition = definitions.get(name);
      if (definition?.type !== "reference" || (targetType !== undefined && !/^[A-Z][A-Za-z]+$/.test(targetType))) {
        if (options.strict)
          throw new FhirError(400, "not-supported", `Unsupported chained parameter "${key}" for ${type}`);
        continue;
      }
      const chainTarget = targetType ?? (definition.targets?.length === 1 ? definition.targets[0] : undefined);
      parsed.criteria.push({
        definition,
        values: [raw],
        key,
        raw,
        chain: { targetType: chainTarget, key: key.slice(dot + 1) },
      });
      parsed.applied.push([key, raw]);
      continue;
    }
    const [name, modifier] = key.split(":", 2);
    const definition = definitions.get(name);
    const supportedModifier =
      modifier === undefined ||
      modifier === "missing" ||
      (definition?.type === "string" && (modifier === "exact" || modifier === "contains")) ||
      (definition?.type === "token" && (modifier === "not" || modifier === "text")) ||
      (definition?.type === "reference" && /^[A-Z][A-Za-z]+$/.test(modifier));
    if (!definition || !supportedModifier) {
      if (options.strict)
        throw new FhirError(400, "not-supported", `Unknown or unsupported search parameter "${key}" for ${type}`);
      continue;
    }
    const values = splitValues(raw);
    if (values.length === 0) continue;
    parsed.criteria.push({ definition, modifier, values, key, raw });
    parsed.applied.push([key, raw]);
  }
  return parsed;
}

function parseInclude(raw: string, iterateFlag: boolean): IncludeDirective | undefined {
  const parts = raw.split(":");
  const iterate = iterateFlag || parts[parts.length - 1] === "iterate";
  if (parts[parts.length - 1] === "iterate") parts.pop();
  const [source, param, target] = parts;
  if (!source || !param || parts.length > 3) return undefined;
  const definition = searchParamsFor(source).get(param);
  if (definition?.type !== "reference") return undefined;
  return { source, definition, target, iterate };
}

// Value extraction

function collect(value: unknown, segments: string[], out: unknown[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, segments, out);
    return;
  }
  if (segments.length === 0) {
    out.push(value);
    return;
  }
  if (typeof value === "object") collect((value as Record<string, unknown>)[segments[0]], segments.slice(1), out);
}

export function valuesAt(resource: FhirResource, definition: SearchParamDefinition): unknown[] {
  const out: unknown[] = [];
  for (const path of definition.paths) collect(resource, path.split("."), out);
  return out;
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Matchers

function matchString(values: unknown[], query: string, modifier?: string): boolean {
  const strings = values.flatMap((v) => stringLeaves(v));
  if (modifier === "exact") return strings.includes(query);
  const q = normalize(query);
  return strings.some((s) => (modifier === "contains" ? normalize(s).includes(q) : normalize(s).startsWith(q)));
}

interface TokenTarget {
  system?: string;
  code?: string;
  text?: string;
}

function tokenTargets(value: unknown): TokenTarget[] {
  if (typeof value === "string") return [{ code: value }];
  if (typeof value === "boolean" || typeof value === "number") return [{ code: String(value) }];
  if (!value || typeof value !== "object") return [];
  const v = value as Record<string, unknown>;
  const targets: TokenTarget[] = [];
  if (Array.isArray(v.coding) || (typeof v.text === "string" && !("code" in v) && !("value" in v))) {
    // CodeableConcept: each coding is a target, and its text is searchable on its own.
    for (const coding of (v.coding ?? []) as Array<Record<string, unknown>>)
      targets.push({
        system: coding.system as string | undefined,
        code: coding.code as string | undefined,
        text: coding.display as string | undefined,
      });
    if (typeof v.text === "string") targets.push({ text: v.text });
  } else if ("value" in v && !("code" in v)) {
    // Identifier or ContactPoint
    targets.push({
      system: v.system as string | undefined,
      code: v.value as string | undefined,
      text: (v.type as { text?: string })?.text,
    });
  } else {
    // Coding
    targets.push({
      system: v.system as string | undefined,
      code: v.code as string | undefined,
      text: v.display as string | undefined,
    });
  }
  return targets;
}

function matchToken(values: unknown[], query: string, modifier?: string): boolean {
  const targets = values.flatMap(tokenTargets);
  if (modifier === "text") {
    const q = normalize(query);
    return targets.some((t) => t.text !== undefined && normalize(t.text).startsWith(q));
  }
  const bar = query.indexOf("|");
  const system = bar === -1 ? undefined : query.slice(0, bar);
  const code = bar === -1 ? query : query.slice(bar + 1);
  return targets.some((t) => {
    if (system !== undefined && system !== "" && t.system !== system) return false;
    if (system === "" && t.system !== undefined) return false;
    return code === "" ? system !== undefined : t.code === code;
  });
}

const DATE_PATTERN =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/** The time range a FHIR date, dateTime, or instant covers, in epoch milliseconds (end exclusive). */
export function dateRange(text: string): Range | undefined {
  const m = DATE_PATTERN.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, ms, tz] = m;
  if (h === undefined) {
    const start = Date.UTC(Number(y), mo ? Number(mo) - 1 : 0, d ? Number(d) : 1);
    const end = d
      ? Date.UTC(Number(y), Number(mo) - 1, Number(d) + 1)
      : mo
        ? Date.UTC(Number(y), Number(mo), 1)
        : Date.UTC(Number(y) + 1, 0, 1);
    return { start, end };
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${ms ? `.${ms}` : ""}${tz ?? "Z"}`;
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return undefined;
  const unit = ms ? 1 : s ? 1000 : 60_000;
  return { start, end: start + unit };
}

function valueRange(value: unknown): Range | undefined {
  if (typeof value === "string") return dateRange(value);
  if (value && typeof value === "object") {
    const period = value as { start?: string; end?: string };
    if (period.start === undefined && period.end === undefined) return undefined;
    const start = period.start ? dateRange(period.start)?.start : -Infinity;
    const end = period.end ? dateRange(period.end)?.end : Infinity;
    if (start === undefined || end === undefined) return undefined;
    return { start, end };
  }
  return undefined;
}

function matchDate(values: unknown[], query: string): boolean {
  const [, prefix = "eq", text] = /^(eq|ne|lt|gt|le|ge|sa|eb|ap)?(.*)$/.exec(query)!;
  const param = dateRange(text);
  if (!param) throw new FhirError(400, "value", `Invalid date search value "${query}"`);
  const ranges = values.map(valueRange).filter((r): r is Range => r !== undefined);
  const contained = (r: Range) => r.start >= param.start && r.end <= param.end;
  return ranges.some((r) => {
    switch (prefix) {
      case "eq":
      case "ap":
        return contained(r);
      case "ne":
        return !contained(r);
      case "gt":
        return r.end > param.end;
      case "lt":
        return r.start < param.start;
      case "ge":
        return r.end > param.end || contained(r);
      case "le":
        return r.start < param.start || contained(r);
      case "sa":
        return r.start >= param.end;
      case "eb":
        return r.end <= param.start;
    }
  });
}

function matchReference(
  values: unknown[],
  query: string,
  definition: SearchParamDefinition,
  modifier?: string,
): boolean {
  const refs = values
    .map((v) => (v && typeof v === "object" ? (v as { reference?: unknown }).reference : undefined))
    .filter((r): r is string => typeof r === "string");
  let wanted: string;
  if (query.includes("/")) wanted = query.split("/").slice(-2).join("/");
  else if (modifier) wanted = `${modifier}/${query}`;
  else if (definition.targets?.length === 1) wanted = `${definition.targets[0]}/${query}`;
  else return refs.some((r) => r.split("/").pop() === query);
  return refs.some((r) => r.split("/").slice(-2).join("/") === wanted);
}

/** "Patient/123", "http://host/Patient/123" -> ["Patient", "123"]. Contained (#id) references are skipped. */
function referenceTarget(reference: unknown): [string, string] | undefined {
  const ref = reference && typeof reference === "object" ? (reference as { reference?: unknown }).reference : undefined;
  return typeof ref === "string" ? parseReference(ref) : undefined;
}

/** "Patient/123", "http://host/Patient/123/_history/2" -> ["Patient", "123"]. Contained (#id) references give undefined. */
export function parseReference(ref: string): [string, string] | undefined {
  if (ref.startsWith("#")) return undefined;
  const parts = ref.split("/").filter(Boolean);
  const historyAt = parts.indexOf("_history");
  const trimmed = historyAt > 0 ? parts.slice(0, historyAt) : parts;
  if (trimmed.length < 2) return undefined;
  return [trimmed[trimmed.length - 2], trimmed[trimmed.length - 1]];
}

function referencedResources(
  resource: FhirResource,
  definition: SearchParamDefinition,
  ctx: SearchContext,
  targetType?: string,
): FhirResource[] {
  const out: FhirResource[] = [];
  for (const value of valuesAt(resource, definition)) {
    const target = referenceTarget(value);
    if (!target || (targetType && target[0] !== targetType)) continue;
    const found = ctx.resolve(target[0], target[1]);
    if (found) out.push(found);
  }
  return out;
}

function matchesChain(resource: FhirResource, criterion: Criterion, ctx: SearchContext, depth: number): boolean {
  const chain = criterion.chain!;
  if (depth > 3) throw new FhirError(400, "not-supported", `Chained parameter "${criterion.key}" is nested too deeply`);
  return referencedResources(resource, criterion.definition, ctx, chain.targetType).some((target) => {
    const sub = parseSearch(target.resourceType, [[chain.key, criterion.raw]]);
    return sub.criteria.length > 0 && sub.criteria.every((c) => matchesCriterion(target, c, ctx, depth + 1));
  });
}

function matchesCriterion(resource: FhirResource, criterion: Criterion, ctx: SearchContext, depth = 0): boolean {
  if (criterion.chain) return matchesChain(resource, criterion, ctx, depth);
  const { definition, modifier, values } = criterion;
  const found = valuesAt(resource, definition);
  if (modifier === "missing") {
    return values.some((v) => (v === "true" ? found.length === 0 : found.length > 0));
  }
  if (modifier === "not") return values.every((v) => !matchToken(found, v));
  return values.some((value) => {
    switch (definition.type) {
      case "string":
        return matchString(found, value, modifier);
      case "token":
        return matchToken(found, value, modifier);
      case "date":
        return matchDate(found, value);
      case "reference":
        return matchReference(found, value, definition, modifier);
    }
  });
}

// Sorting

function sortKey(resource: FhirResource, definition: SearchParamDefinition): string | number | undefined {
  const found = valuesAt(resource, definition);
  if (definition.type === "date") {
    const starts = found
      .map(valueRange)
      .filter((r): r is Range => r !== undefined)
      .map((r) => r.start);
    return starts.length ? Math.min(...starts) : undefined;
  }
  if (definition.type === "token") {
    const codes = found
      .flatMap(tokenTargets)
      .map((t) => t.code ?? t.text)
      .filter((c): c is string => c !== undefined);
    return codes.sort()[0];
  }
  return found
    .flatMap((v) => stringLeaves(v))
    .map(normalize)
    .sort()[0];
}

function compareKeys(a: string | number | undefined, b: string | number | undefined): number {
  if (a === b) return 0;
  // Resources without a value sort last.
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

export interface SearchResult {
  total: number;
  matches: FhirResource[];
}

export function runSearch(resources: FhirResource[], search: ParsedSearch, ctx: SearchContext): SearchResult {
  let matches = resources.filter((r) => search.criteria.every((c) => matchesCriterion(r, c, ctx)));
  if (search.sort.length > 0) {
    matches = matches
      .map((resource) => ({ resource, keys: search.sort.map((s) => sortKey(resource, s.definition)) }))
      .sort((a, b) => {
        for (const [i, s] of search.sort.entries()) {
          const keyA = a.keys[i];
          const keyB = b.keys[i];
          if (keyA === undefined || keyB === undefined) {
            const order = compareKeys(keyA, keyB);
            if (order !== 0) return order;
            continue;
          }
          const order = compareKeys(keyA, keyB);
          if (order !== 0) return s.descending ? -order : order;
        }
        return 0;
      })
      .map((x) => x.resource);
  }
  return { total: matches.length, matches };
}

const MAX_INCLUDE_ROUNDS = 5;
const key = (r: FhirResource) => `${r.resourceType}/${r.id}`;

/**
 * Resources to add to a page for _include and _revinclude, excluding the page itself.
 * Directives marked iterate also apply to resources added by earlier rounds.
 */
export function resolveIncludes(page: FhirResource[], search: ParsedSearch, ctx: SearchContext): FhirResource[] {
  if (search.includes.length === 0 && search.revincludes.length === 0) return [];
  const seen = new Set(page.map(key));
  const added: FhirResource[] = [];
  const add = (r: FhirResource, next: FhirResource[]) => {
    if (seen.has(key(r))) return;
    seen.add(key(r));
    added.push(r);
    next.push(r);
  };
  let frontier = page;
  for (let round = 0; round < MAX_INCLUDE_ROUNDS && frontier.length > 0; round++) {
    const next: FhirResource[] = [];
    const active = (d: IncludeDirective) => round === 0 || d.iterate;
    for (const directive of search.includes.filter(active)) {
      for (const resource of frontier.filter((r) => r.resourceType === directive.source))
        for (const target of referencedResources(resource, directive.definition, ctx, directive.target))
          add(target, next);
    }
    for (const directive of search.revincludes.filter(active)) {
      const wanted = new Set(frontier.filter((r) => !directive.target || r.resourceType === directive.target).map(key));
      if (wanted.size === 0) continue;
      for (const candidate of ctx.listCurrent(directive.source)) {
        const refs = valuesAt(candidate, directive.definition).map(referenceTarget);
        if (refs.some((t) => t && wanted.has(`${t[0]}/${t[1]}`))) add(candidate, next);
      }
    }
    frontier = next;
  }
  return added;
}
