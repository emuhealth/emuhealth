import type { OpenFdaRecord } from "./data.js";

// The openFDA query language: search=field:term clauses joined by AND or OR (a space, written + in URLs, is OR),
// "quoted phrases", .exact fields, [from TO to] ranges, trailing * wildcards, _exists_ and _missing_, NOT, and
// parentheses. Plus sort=field:asc|desc, count=field, limit, and skip.

export class OpenFdaError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "BAD_REQUEST" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

type Node =
  | { kind: "and" | "or"; children: Node[] }
  | { kind: "not"; child: Node }
  | { kind: "term"; field?: string; value: string; phrase: boolean }
  | { kind: "range"; field: string; from: string; to: string }
  | { kind: "exists"; field: string; missing: boolean };

type Token = { type: "word"; text: string } | { type: "phrase"; text: string } | { type: "(" | ")" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ type: ch });
      i++;
    } else {
      // A word runs to whitespace or a closing parenthesis, but quotes and [ranges] may contain spaces.
      let text = "";
      let phrase = false;
      while (i < input.length && !/\s/.test(input[i]) && input[i] !== ")") {
        if (input[i] === '"') {
          const close = input.indexOf('"', i + 1);
          if (close < 0) throw new OpenFdaError(400, "BAD_REQUEST", "Unterminated quote in search");
          text += input.slice(i, close + 1);
          phrase = true;
          i = close + 1;
        } else if (input[i] === "[") {
          const close = input.indexOf("]", i + 1);
          if (close < 0) throw new OpenFdaError(400, "BAD_REQUEST", "Unterminated range in search");
          text += input.slice(i, close + 1);
          i = close + 1;
        } else if (input[i] === "(" && text.endsWith(":")) {
          // field:(a b) groups several terms for one field.
          const close = input.indexOf(")", i + 1);
          if (close < 0) throw new OpenFdaError(400, "BAD_REQUEST", "Unbalanced parentheses in search");
          text += input.slice(i, close + 1);
          i = close + 1;
        } else {
          text += input[i++];
        }
      }
      tokens.push(phrase && /^[^:]*:?"/.test(text) ? { type: "phrase", text } : { type: "word", text });
    }
  }
  return tokens;
}

function parseClause(text: string): Node {
  const colon = text.search(/:(?=["[(\w*-]|$)/);
  const field = colon > 0 ? text.slice(0, colon) : undefined;
  let value = colon > 0 ? text.slice(colon + 1) : text;
  if (field === "_exists_" || field === "_missing_")
    return { kind: "exists", field: value, missing: field === "_missing_" };
  if (!field && !value) throw new OpenFdaError(400, "BAD_REQUEST", "Empty search clause");
  const range = /^\[(.+?) TO (.+?)\]$/i.exec(value);
  if (range) {
    if (!field) throw new OpenFdaError(400, "BAD_REQUEST", "A range needs a field");
    return { kind: "range", field, from: range[1], to: range[2] };
  }
  const group = /^\((.*)\)$/.exec(value);
  if (group) {
    const inner = parse(tokenize(group[1]));
    return withField(inner, field);
  }
  const phrase = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
  if (phrase) value = value.slice(1, -1);
  return { kind: "term", field, value, phrase };
}

function withField(node: Node, field: string | undefined): Node {
  if (!field) return node;
  if (node.kind === "term" && !node.field) return { ...node, field };
  if (node.kind === "and" || node.kind === "or")
    return { ...node, children: node.children.map((c) => withField(c, field)) };
  if (node.kind === "not") return { ...node, child: withField(node.child, field) };
  return node;
}

function parse(tokens: Token[]): Node {
  let pos = 0;
  const isOp = (t: Token | undefined, op: string) => t?.type === "word" && t.text === op;
  const text = (t: Token) => ("text" in t ? t.text : "");

  function primary(): Node {
    const token = tokens[pos];
    if (!token) throw new OpenFdaError(400, "BAD_REQUEST", "Incomplete search");
    if (token.type === "(") {
      pos++;
      const node = or();
      if (tokens[pos]?.type !== ")") throw new OpenFdaError(400, "BAD_REQUEST", "Unbalanced parentheses in search");
      pos++;
      return node;
    }
    if (token.type === ")") throw new OpenFdaError(400, "BAD_REQUEST", "Unbalanced parentheses in search");
    if (isOp(token, "NOT")) {
      pos++;
      return { kind: "not", child: primary() };
    }
    pos++;
    return parseClause(text(token));
  }

  function and(): Node {
    const children = [primary()];
    while (isOp(tokens[pos], "AND")) {
      pos++;
      children.push(primary());
    }
    return children.length === 1 ? children[0] : { kind: "and", children };
  }

  function or(): Node {
    const children = [and()];
    while (pos < tokens.length && tokens[pos].type !== ")") {
      if (isOp(tokens[pos], "OR")) pos++;
      children.push(and());
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  const node = or();
  if (pos < tokens.length) throw new OpenFdaError(400, "BAD_REQUEST", "Unbalanced parentheses in search");
  return node;
}

export function parseSearch(search: string): Node {
  if (!search.trim()) throw new OpenFdaError(400, "BAD_REQUEST", "Empty search");
  return parse(tokenize(search));
}

/** Every primitive value at a dotted path, descending through arrays. */
export function valuesAt(record: unknown, path: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, parts: string[]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, parts);
      return;
    }
    if (parts.length === 0) {
      if (typeof value !== "object") out.push(String(value));
      return;
    }
    if (typeof value === "object") walk((value as Record<string, unknown>)[parts[0]], parts.slice(1));
  };
  walk(record, path.split("."));
  return out;
}

/** Every primitive value anywhere in the record, for terms without a field. */
function allValues(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) allValues(item, out);
  else if (value && typeof value === "object") for (const child of Object.values(value)) allValues(child, out);
  else if (value !== undefined && value !== null) out.push(String(value));
  return out;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function matchesTerm(values: string[], value: string, phrase: boolean, exact: boolean): boolean {
  if (exact) {
    if (value.endsWith("*")) return values.some((v) => v.startsWith(value.slice(0, -1)));
    return values.includes(value);
  }
  const wanted = words(value);
  if (wanted.length === 0) return false;
  const prefix = value.endsWith("*") && !phrase;
  return values.some((v) => {
    const have = words(v);
    if (prefix && wanted.length === 1) return have.some((w) => w.startsWith(wanted[0]));
    if (!phrase && wanted.length > 1) return wanted.every((w) => have.includes(w));
    for (let i = 0; i + wanted.length <= have.length; i++) if (wanted.every((w, j) => have[i + j] === w)) return true;
    return false;
  });
}

const fieldPath = (field: string) => ({ path: field.replace(/\.exact$/, ""), exact: field.endsWith(".exact") });

export function matches(record: OpenFdaRecord, node: Node): boolean {
  switch (node.kind) {
    case "and":
      return node.children.every((c) => matches(record, c));
    case "or":
      return node.children.some((c) => matches(record, c));
    case "not":
      return !matches(record, node.child);
    case "exists": {
      const present = valuesAt(record, fieldPath(node.field).path).length > 0;
      return node.missing ? !present : present;
    }
    case "range": {
      const values = valuesAt(record, fieldPath(node.field).path);
      const numeric = [node.from, node.to].every((v) => v === "*" || !Number.isNaN(Number(v)));
      return values.some((v) => {
        const above = node.from === "*" || (numeric ? Number(v) >= Number(node.from) : v >= node.from);
        const below = node.to === "*" || (numeric ? Number(v) <= Number(node.to) : v <= node.to);
        return above && below;
      });
    }
    case "term": {
      if (!node.field) return matchesTerm(allValues(record), node.value, node.phrase, false);
      const { path, exact } = fieldPath(node.field);
      return matchesTerm(valuesAt(record, path), node.value, node.phrase, exact);
    }
  }
}

export interface QueryResult {
  total: number;
  skip: number;
  limit: number;
  results: OpenFdaRecord[];
}

/** Run a search with sort, skip, and limit, the way openFDA does: limit defaults to 1 and caps at 1000. */
export function runQuery(records: OpenFdaRecord[], params: URLSearchParams): QueryResult {
  const search = params.get("search");
  let hits = search ? records.filter((r) => matches(r, parseSearch(search))) : records;
  const limit = integer(params.get("limit"), 1, "limit");
  const skip = integer(params.get("skip"), 0, "skip");
  if (limit > 1000)
    throw new OpenFdaError(
      400,
      "BAD_REQUEST",
      "Limit cannot exceed 1000 results for search requests. Use the skip or search_after param to get additional results.",
    );
  if (skip > 25000) throw new OpenFdaError(400, "BAD_REQUEST", "Skip value must 25000 or less.");
  const sort = params.get("sort");
  if (sort) {
    const [field, direction = "asc"] = sort.split(":");
    if (direction !== "asc" && direction !== "desc")
      throw new OpenFdaError(400, "BAD_REQUEST", "Sort direction must be asc or desc");
    const { path } = fieldPath(field);
    const key = (r: OpenFdaRecord) => valuesAt(r, path)[0] ?? "";
    hits = [...hits].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
    if (direction === "desc") hits.reverse();
  }
  if (hits.length === 0) throw new OpenFdaError(404, "NOT_FOUND", "No matches found!");
  return { total: hits.length, skip, limit, results: hits.slice(skip, skip + limit) };
}

/** count=field: term counts, most frequent first. Non-exact fields count words, as openFDA's analyzed fields do. */
export function runCount(records: OpenFdaRecord[], params: URLSearchParams): Array<{ term: string; count: number }> {
  const search = params.get("search");
  const hits = search ? records.filter((r) => matches(r, parseSearch(search))) : records;
  const { path, exact } = fieldPath(params.get("count")!);
  const limit = integer(params.get("limit"), 100, "limit");
  if (limit > 1000) throw new OpenFdaError(400, "BAD_REQUEST", "Limit cannot exceed 1000 for count requests.");
  const counts = new Map<string, number>();
  for (const record of hits) {
    const terms = new Set(valuesAt(record, path).flatMap((v) => (exact ? [v] : words(v))));
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  if (counts.size === 0) throw new OpenFdaError(404, "NOT_FOUND", "No matches found!");
  return [...counts]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit);
}

function integer(raw: string | null, fallback: number, name: string): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new OpenFdaError(400, "BAD_REQUEST", `Invalid ${name} parameter: ${raw}`);
  return value;
}
