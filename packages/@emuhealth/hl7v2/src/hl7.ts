// HL7 v2 ER7 parsing and building, and MLLP framing.

export const MLLP_START = 0x0b;
export const MLLP_END = Buffer.from([0x1c, 0x0d]);

export class Hl7ParseError extends Error {}

export interface Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

export interface Segment {
  name: string;
  /** fields[n] is field n of the segment (for MSH, fields[1] is the field separator). */
  fields: string[];
}

export interface Message {
  delimiters: Delimiters;
  segments: Segment[];
}

export const DEFAULT_DELIMITERS: Delimiters = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
};

export function parseMessage(text: string): Message {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length);
  if (!lines.length || !lines[0].startsWith("MSH") || lines[0].length < 8)
    throw new Hl7ParseError("The message does not start with an MSH segment");
  const msh = lines[0];
  const field = msh[3];
  const [component, repetition, escape, subcomponent] = msh.slice(4, 8);
  const delimiters: Delimiters = { field, component, repetition, escape, subcomponent: subcomponent ?? "&" };
  const segments = lines.map((line): Segment => {
    const parts = line.split(field);
    const name = parts[0];
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name))
      throw new Hl7ParseError(`Invalid segment name ${JSON.stringify(name.slice(0, 8))}`);
    // MSH-1 is the field separator itself, so MSH fields shift by one.
    return { name, fields: name === "MSH" ? [name, field, ...parts.slice(1)] : parts };
  });
  return { delimiters, segments };
}

/** Decode HL7 escape sequences in a value. */
export function unescape(value: string, d: Delimiters): string {
  if (!value.includes(d.escape)) return value;
  const e = d.escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`${e}([FSTRE]|\\.br|X[0-9A-Fa-f]+)${e}`, "g"), (_, code: string) => {
    if (code === "F") return d.field;
    if (code === "S") return d.component;
    if (code === "T") return d.subcomponent;
    if (code === "R") return d.repetition;
    if (code === "E") return d.escape;
    if (code === ".br") return "\n";
    return Buffer.from(code.slice(1), "hex").toString("latin1");
  });
}

/** Encode delimiter characters in a value. */
export function escape(value: string, d: Delimiters = DEFAULT_DELIMITERS): string {
  let out = "";
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.subcomponent) out += `${d.escape}T${d.escape}`;
    else if (ch === d.repetition) out += `${d.escape}R${d.escape}`;
    else if (ch === "\r" || ch === "\n") out += `${d.escape}.br${d.escape}`;
    else out += ch;
  }
  return out;
}

export function segments(m: Message, name: string): Segment[] {
  return m.segments.filter((s) => s.name === name);
}

export function segment(m: Message, name: string): Segment | undefined {
  return m.segments.find((s) => s.name === name);
}

/** A field's components (of its first repetition), unescaped. get(seg, 5) is the whole field, get(seg, 5, 2) one component. */
export function get(m: Message, seg: Segment | undefined, field: number, component?: number, repetition = 0): string {
  const raw = seg?.fields[field] ?? "";
  if (seg?.name === "MSH" && field <= 2) return raw;
  const rep = raw.split(m.delimiters.repetition)[repetition] ?? "";
  if (component === undefined) return unescape(rep, m.delimiters);
  const comp = rep.split(m.delimiters.component)[component - 1] ?? "";
  return unescape(comp.split(m.delimiters.subcomponent)[0], m.delimiters);
}

export function repetitions(m: Message, seg: Segment | undefined, field: number): string[] {
  const raw = seg?.fields[field] ?? "";
  return raw ? raw.split(m.delimiters.repetition) : [];
}

export function components(m: Message, value: string): string[] {
  return value.split(m.delimiters.component).map((c) => unescape(c.split(m.delimiters.subcomponent)[0], m.delimiters));
}

/** Build a segment from field values (arrays are joined as components). Values are escaped. */
export function build(name: string, fields: Array<string | string[] | undefined>): string {
  const values = fields.map((f) =>
    f === undefined ? "" : Array.isArray(f) ? f.map((c) => escape(c)).join("^") : escape(f),
  );
  while (values.length && values[values.length - 1] === "") values.pop();
  return [name, ...values].join("|");
}

/** An MSH segment. Fields here start at MSH-3 (sending application). */
export function msh(fields: Array<string | string[] | undefined>): string {
  return `MSH|^~\\&|${build("X", fields).slice(2)}`;
}

/** An HL7 timestamp (YYYYMMDDHHMMSS) in UTC. */
export function hl7Time(date = new Date()): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** Wrap a message in an MLLP frame. Segments are separated with carriage returns. */
export function frame(message: string): Buffer {
  const body = message.replace(/\r\n|\n/g, "\r");
  return Buffer.concat([
    Buffer.from([MLLP_START]),
    Buffer.from(body.endsWith("\r") ? body : `${body}\r`, "utf8"),
    MLLP_END,
  ]);
}

/** Pull complete MLLP frames off a buffer, returning the messages and the remaining bytes. */
export function deframe(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(MLLP_START);
    if (start < 0) return { messages, rest: Buffer.alloc(0) };
    const end = rest.indexOf(MLLP_END, start + 1);
    if (end < 0) return { messages, rest: rest.subarray(start) };
    messages.push(rest.toString("utf8", start + 1, end));
    rest = rest.subarray(end + 2);
  }
}
