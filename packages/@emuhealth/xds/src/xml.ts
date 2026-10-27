// A small XML parser and builder (the same as the Rave emulator's): elements, attributes, text, comments, CDATA,
// processing instructions, and the five predefined entities plus numeric character references.

export class XmlError extends Error {}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    if (ref in ENTITIES) return ENTITIES[ref];
    throw new XmlError(`Unknown entity ${whole}`);
  });
}

export function parseXml(input: string): XmlElement {
  const text = input.replace(/^﻿/, "");
  let pos = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) {
      if (text.slice(pos).trim()) throw new XmlError("Text outside the root element");
      break;
    }
    if (lt > pos && stack.length) stack[stack.length - 1].text += decode(text.slice(pos, lt));
    else if (lt > pos && text.slice(pos, lt).trim()) throw new XmlError("Text outside the root element");
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("Unterminated comment");
      pos = end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end < 0 || !stack.length) throw new XmlError("Misplaced or unterminated CDATA section");
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      pos = end + 3;
    } else if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("Unterminated processing instruction");
      pos = end + 2;
    } else if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end < 0) throw new XmlError("Unterminated declaration");
      pos = end + 1;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt);
      if (end < 0) throw new XmlError("Unterminated end tag");
      const name = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`Mismatched end tag </${name}>`);
      pos = end + 1;
    } else {
      const tag = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(lt));
      if (!tag) throw new XmlError(`Invalid tag at offset ${lt}`);
      const el: XmlElement = { name: tag[1], attrs: {}, children: [], text: "" };
      pos = lt + tag[0].length;
      const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
      for (;;) {
        attr.lastIndex = pos;
        const m = attr.exec(text);
        if (!m) break;
        el.attrs[m[1]] = decode(m[3] ?? m[4] ?? "");
        pos = attr.lastIndex;
      }
      const close = /^\s*(\/?)>/.exec(text.slice(pos));
      if (!close) throw new XmlError(`Malformed start tag <${el.name}>`);
      pos += close[0].length;
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) throw new XmlError("More than one root element");
      else root = el;
      if (!close[1]) stack.push(el);
    }
  }
  if (stack.length) throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new XmlError("No root element");
  return root;
}

/** The local part of a possibly prefixed name. */
export const local = (name: string) => name.slice(name.indexOf(":") + 1);

export const childrenNamed = (el: XmlElement, name: string) => el.children.filter((c) => local(c.name) === name);

export const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build an element. Attributes with undefined values are left out; children are pre-built strings. */
export function el(
  name: string,
  attrs: Record<string, string | number | undefined> = {},
  ...children: Array<string | false | undefined>
): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  const body = children.filter((c): c is string => typeof c === "string").join("");
  return body ? `<${name}${a}>${body}</${name}>` : `<${name}${a} />`;
}

export const textEl = (name: string, text: string, attrs: Record<string, string | number | undefined> = {}) =>
  el(name, attrs, escapeXml(text) || undefined);
