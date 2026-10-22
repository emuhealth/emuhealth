import { FhirError } from "./outcome.js";

// JSON Patch (RFC 6902) with JSON Pointer paths (RFC 6901).
export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

type Container = Record<string, unknown> | unknown[];

function invalid(message: string): FhirError {
  return new FhirError(400, "invalid", `Invalid JSON Patch: ${message}`);
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw invalid(`path "${pointer}" must start with "/"`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value);
}

function arrayIndex(array: unknown[], token: string, allowEnd: boolean): number {
  if (allowEnd && token === "-") return array.length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw invalid(`"${token}" is not an array index`);
  const index = Number(token);
  if (index > array.length || (!allowEnd && index === array.length)) throw invalid(`index ${index} is out of range`);
  return index;
}

function resolveParent(doc: unknown, tokens: string[], pointer: string): { parent: Container; key: string } {
  let current = doc;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(current)) current = current[arrayIndex(current, token, false)];
    else if (isObject(current) && Object.hasOwn(current, token)) current = current[token];
    else throw invalid(`path "${pointer}" does not exist`);
  }
  if (!isContainer(current)) throw invalid(`path "${pointer}" does not exist`);
  return { parent: current, key: tokens[tokens.length - 1] };
}

function getValue(doc: unknown, pointer: string): unknown {
  let current = doc;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(current)) current = current[arrayIndex(current, token, false)];
    else if (isObject(current) && Object.hasOwn(current, token)) current = current[token];
    else throw invalid(`path "${pointer}" does not exist`);
  }
  return current;
}

function addValue(doc: unknown, pointer: string, value: unknown): unknown {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return value;
  const { parent, key } = resolveParent(doc, tokens, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true), 0, value);
  else parent[key] = value;
  return doc;
}

function removeValue(doc: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) throw invalid("cannot remove the whole document");
  const { parent, key } = resolveParent(doc, tokens, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, false), 1);
  else if (Object.hasOwn(parent, key)) delete parent[key];
  else throw invalid(`path "${pointer}" does not exist`);
  return doc;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isContainer(a) && isContainer(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function applyJsonPatch<T>(document: T, operations: unknown): T {
  if (!Array.isArray(operations)) throw invalid("body must be an array of operations");
  let doc: unknown = structuredClone(document);
  for (const raw of operations) {
    if (!isContainer(raw) || Array.isArray(raw) || typeof raw.op !== "string" || typeof raw.path !== "string")
      throw invalid("each operation needs string op and path members");
    const op = raw as unknown as JsonPatchOperation;
    switch (op.op) {
      case "add":
        if (!("value" in op)) throw invalid('"add" needs a value');
        doc = addValue(doc, op.path, structuredClone(op.value));
        break;
      case "remove":
        doc = removeValue(doc, op.path);
        break;
      case "replace":
        if (!("value" in op)) throw invalid('"replace" needs a value');
        getValue(doc, op.path);
        doc =
          op.path === ""
            ? structuredClone(op.value)
            : addValue(removeValue(doc, op.path), op.path, structuredClone(op.value));
        break;
      case "move": {
        if (typeof op.from !== "string") throw invalid('"move" needs a from path');
        if (op.path.startsWith(`${op.from}/`)) throw invalid("cannot move a value into one of its children");
        const value = getValue(doc, op.from);
        doc = addValue(removeValue(doc, op.from), op.path, value);
        break;
      }
      case "copy":
        if (typeof op.from !== "string") throw invalid('"copy" needs a from path');
        doc = addValue(doc, op.path, structuredClone(getValue(doc, op.from)));
        break;
      case "test":
        if (!deepEqual(getValue(doc, op.path), op.value))
          throw new FhirError(422, "processing", `JSON Patch test failed at "${op.path}"`);
        break;
      default:
        throw invalid(`unknown op "${String((op as { op: unknown }).op)}"`);
    }
  }
  return doc as T;
}
