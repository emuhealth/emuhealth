// A subset of the Vault Query Language: SELECT fields FROM target [WHERE ...] [ORDER BY ...] [MAXROWS n]
// [PAGESIZE n] [PAGEOFFSET n], with =, !=, <, >, <=, >=, LIKE, IN, CONTAINS, AND, OR, NOT, and parentheses.

export class VqlError extends Error {}

export type Value = string | number | boolean | null;

export type Condition =
  | { kind: "and" | "or"; left: Condition; right: Condition }
  | { kind: "not"; inner: Condition }
  | { kind: "compare"; field: string; op: "=" | "!=" | "<" | ">" | "<=" | ">="; value: Value }
  | { kind: "like"; field: string; pattern: string }
  | { kind: "in"; field: string; values: Value[]; contains: boolean };

export interface Query {
  fields: string[];
  target: string;
  where?: Condition;
  orderBy: Array<{ field: string; desc: boolean }>;
  maxRows?: number;
  pageSize?: number;
  pageOffset?: number;
}

type Token = { type: "word" | "string" | "number" | "op" | "punct"; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= text.length) throw new VqlError("Unterminated string literal");
        if (text[i] === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else if (text[i] === "'") {
          i++;
          break;
        } else value += text[i++];
      }
      tokens.push({ type: "string", value });
      continue;
    }
    const op = /^(<=|>=|!=|<>|=|<|>)/.exec(text.slice(i));
    if (op) {
      tokens.push({ type: "op", value: op[1] === "<>" ? "!=" : op[1] });
      i += op[1].length;
      continue;
    }
    if ("(),*".includes(ch)) {
      tokens.push({ type: "punct", value: ch });
      i++;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (num) {
      tokens.push({ type: "number", value: num[0] });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i));
    if (word) {
      tokens.push({ type: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    throw new VqlError(`Unexpected character '${ch}'`);
  }
  return tokens;
}

export function parseVql(text: string): Query {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (w: string, t = peek()) => t?.type === "word" && t.value.toUpperCase() === w;
  const expectWord = (w: string) => {
    if (!isWord(w)) throw new VqlError(`Expected ${w}${peek() ? ` near '${peek().value}'` : " at end of query"}`);
    pos++;
  };
  const ident = (what: string) => {
    const t = tokens[pos++];
    if (t?.type !== "word") throw new VqlError(`Expected ${what}${t ? ` near '${t.value}'` : ""}`);
    return t.value;
  };
  const integer = (what: string) => {
    const t = tokens[pos++];
    if (t?.type !== "number" || !/^\d+$/.test(t.value)) throw new VqlError(`${what} needs a whole number`);
    return Number(t.value);
  };
  const value = (): Value => {
    const t = tokens[pos++];
    if (!t) throw new VqlError("Expected a value at end of query");
    if (t.type === "string") return t.value;
    if (t.type === "number") return Number(t.value);
    if (t.type === "word" && /^(true|false)$/i.test(t.value)) return t.value.toLowerCase() === "true";
    if (t.type === "word" && /^null$/i.test(t.value)) return null;
    throw new VqlError(`Expected a value near '${t.value}'`);
  };
  const list = (): Value[] => {
    if (peek()?.value !== "(") throw new VqlError("Expected ( after IN");
    pos++;
    const out = [value()];
    while (peek()?.value === ",") {
      pos++;
      out.push(value());
    }
    if (tokens[pos++]?.value !== ")") throw new VqlError("Expected ) to close the list");
    return out;
  };

  const factor = (): Condition => {
    if (isWord("NOT")) {
      pos++;
      return { kind: "not", inner: factor() };
    }
    if (peek()?.value === "(") {
      pos++;
      const inner = expr();
      if (tokens[pos++]?.value !== ")") throw new VqlError("Expected ) to close the condition");
      return inner;
    }
    const field = ident("a field name");
    if (isWord("NOT") && (isWord("IN", tokens[pos + 1]) || isWord("LIKE", tokens[pos + 1]))) {
      pos++;
      return { kind: "not", inner: predicate(field) };
    }
    return predicate(field);
  };
  const predicate = (field: string): Condition => {
    if (isWord("IN") || isWord("CONTAINS")) {
      const contains = isWord("CONTAINS");
      pos++;
      return { kind: "in", field, values: list(), contains };
    }
    if (isWord("LIKE")) {
      pos++;
      const pattern = value();
      if (typeof pattern !== "string") throw new VqlError("LIKE needs a string pattern");
      return { kind: "like", field, pattern };
    }
    const t = tokens[pos++];
    if (t?.type !== "op") throw new VqlError(`Expected an operator after ${field}`);
    return { kind: "compare", field, op: t.value as "=", value: value() };
  };
  const term = (): Condition => {
    let left = factor();
    while (isWord("AND")) {
      pos++;
      left = { kind: "and", left, right: factor() };
    }
    return left;
  };
  const expr = (): Condition => {
    let left = term();
    while (isWord("OR")) {
      pos++;
      left = { kind: "or", left, right: term() };
    }
    return left;
  };

  expectWord("SELECT");
  const fields: string[] = [];
  if (peek()?.value === "*") throw new VqlError("SELECT * is not supported; name the fields");
  fields.push(ident("a field name"));
  while (peek()?.value === ",") {
    pos++;
    fields.push(ident("a field name"));
  }
  expectWord("FROM");
  const query: Query = { fields, target: ident("a query target"), orderBy: [] };
  while (pos < tokens.length) {
    if (isWord("WHERE")) {
      pos++;
      query.where = expr();
    } else if (isWord("ORDER")) {
      pos++;
      expectWord("BY");
      do {
        if (peek()?.value === ",") pos++;
        const field = ident("a field name");
        let desc = false;
        if (isWord("ASC")) pos++;
        else if (isWord("DESC")) {
          pos++;
          desc = true;
        }
        query.orderBy.push({ field, desc });
      } while (peek()?.value === ",");
    } else if (isWord("MAXROWS")) {
      pos++;
      query.maxRows = integer("MAXROWS");
    } else if (isWord("PAGESIZE")) {
      pos++;
      query.pageSize = integer("PAGESIZE");
    } else if (isWord("PAGEOFFSET")) {
      pos++;
      query.pageOffset = integer("PAGEOFFSET");
    } else throw new VqlError(`Unexpected '${peek().value}'`);
  }
  return query;
}

const comparable = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function likeRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\?*]/g, "\\$&").replace(/%/g, ".*");
  return new RegExp(`^${body}$`, "i");
}

/** Evaluate a condition against a record. Picklist and multi-value fields match when any value matches. */
export function matches(record: Record<string, unknown>, c: Condition | undefined): boolean {
  if (!c) return true;
  switch (c.kind) {
    case "and":
      return matches(record, c.left) && matches(record, c.right);
    case "or":
      return matches(record, c.left) || matches(record, c.right);
    case "not":
      return !matches(record, c.inner);
    case "like": {
      const re = likeRegex(c.pattern);
      const v = record[c.field];
      return (Array.isArray(v) ? v : [v]).some((x) => x !== null && x !== undefined && re.test(String(x)));
    }
    case "in": {
      const v = record[c.field];
      return (Array.isArray(v) ? v : [v]).some((x) => c.values.some((w) => w === x || String(w) === String(x)));
    }
    case "compare": {
      const raw = record[c.field];
      const values = Array.isArray(raw) ? raw : [raw];
      return values.some((v) => {
        if (c.value === null) return c.op === "=" ? v === null || v === undefined : v !== null && v !== undefined;
        if (v === null || v === undefined) return c.op === "!=";
        const a = typeof c.value === "number" ? Number(v) : typeof c.value === "boolean" ? v === true : String(v);
        const b = c.value;
        switch (c.op) {
          case "=":
            return typeof a === "string" ? a.toLowerCase() === String(b).toLowerCase() : a === b;
          case "!=":
            return typeof a === "string" ? a.toLowerCase() !== String(b).toLowerCase() : a !== b;
          case "<":
            return a < b;
          case ">":
            return a > b;
          case "<=":
            return a <= b;
          case ">=":
            return a >= b;
        }
        return false;
      });
    }
  }
}

export function fieldsOf(c: Condition | undefined, out: string[] = []): string[] {
  if (!c) return out;
  switch (c.kind) {
    case "and":
    case "or":
      fieldsOf(c.left, out);
      fieldsOf(c.right, out);
      break;
    case "not":
      fieldsOf(c.inner, out);
      break;
    default:
      out.push(c.field);
  }
  return out;
}

export function sortRecords<T extends Record<string, unknown>>(rows: T[], orderBy: Query["orderBy"]): T[] {
  if (!orderBy.length) return rows;
  return [...rows].sort((x, y) => {
    for (const { field, desc } of orderBy) {
      const a = comparable(x[field]);
      const b = comparable(y[field]);
      if (a === b) continue;
      if (a === null || a === undefined) return desc ? 1 : -1;
      if (b === null || b === undefined) return desc ? -1 : 1;
      const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      if (cmp) return desc ? -cmp : cmp;
    }
    return 0;
  });
}
