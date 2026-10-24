import { randomUUID } from "node:crypto";
import { childrenNamed, el, local, parseXml, textEl, type XmlElement } from "./xml.js";

// SOAP 1.2 with WS-Addressing, as IHE ITI transactions use, and MTOM/XOP: requests may carry documents as
// multipart/related attachments referenced by xop:Include, and responses use MTOM when the request did.

export const SOAP = "http://www.w3.org/2003/05/soap-envelope";
export const WSA = "http://www.w3.org/2005/08/addressing";
const XOP = "http://www.w3.org/2004/08/xop/include";

export interface SoapRequest {
  action: string;
  messageId?: string;
  body: XmlElement;
  /** Attachments by Content-ID, for xop:Include references. */
  attachments: Map<string, Buffer>;
  mtom: boolean;
}

export class SoapFault extends Error {
  constructor(
    readonly code: "Sender" | "Receiver",
    message: string,
  ) {
    super(message);
  }
}

function parseMultipart(raw: Buffer, contentType: string): { root: string; attachments: Map<string, Buffer> } {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) throw new SoapFault("Sender", "multipart/related without a boundary");
  const start = /start="?<?([^";>]+)>?"?/i.exec(contentType)?.[1];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ id?: string; body: Buffer }> = [];
  let pos = raw.indexOf(delimiter);
  while (pos !== -1) {
    const next = raw.indexOf(delimiter, pos + delimiter.length);
    if (next === -1) break;
    const part = raw.subarray(pos + delimiter.length, next);
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1) {
      const headers = part.subarray(0, split).toString("utf8");
      let body = part.subarray(split + 4);
      if (body.subarray(-2).toString() === "\r\n") body = body.subarray(0, -2);
      const id = /content-id:\s*<?([^>\r\n]+)>?/i.exec(headers)?.[1];
      parts.push({ id, body });
    }
    pos = next;
  }
  if (!parts.length) throw new SoapFault("Sender", "The multipart message has no parts");
  const rootPart = (start && parts.find((p) => p.id === start)) || parts[0];
  const attachments = new Map(parts.filter((p) => p !== rootPart && p.id).map((p) => [p.id!, p.body]));
  return { root: rootPart.body.toString("utf8"), attachments };
}

export function parseSoap(raw: Buffer, contentType: string): SoapRequest {
  const mtom = /multipart\/related/i.test(contentType);
  const { root, attachments } = mtom
    ? parseMultipart(raw, contentType)
    : { root: raw.toString("utf8"), attachments: new Map<string, Buffer>() };
  let envelope: XmlElement;
  try {
    envelope = parseXml(root);
  } catch (error) {
    throw new SoapFault("Sender", `The message is not well formed XML: ${(error as Error).message}`);
  }
  if (local(envelope.name) !== "Envelope") throw new SoapFault("Sender", "The message is not a SOAP envelope");
  const header = childrenNamed(envelope, "Header")[0];
  const body = childrenNamed(envelope, "Body")[0]?.children[0];
  if (!body) throw new SoapFault("Sender", "The SOAP Body is empty");
  const action =
    (header && childrenNamed(header, "Action")[0]?.text.trim()) || /action="([^"]+)"/i.exec(contentType)?.[1] || "";
  if (!action) throw new SoapFault("Sender", "The request has no WS-Addressing Action");
  return { action, messageId: header && childrenNamed(header, "MessageID")[0]?.text.trim(), body, attachments, mtom };
}

/** A document's bytes: inline base64 text, or an xop:Include of an attachment. */
export function documentBytes(element: XmlElement, attachments: Map<string, Buffer>): Buffer {
  const include = element.children.find((c) => local(c.name) === "Include");
  if (include) {
    const id = decodeURIComponent((include.attrs.href ?? "").replace(/^cid:/, ""));
    const data = attachments.get(id);
    if (!data) throw new SoapFault("Sender", `The attachment ${id} is missing`);
    return data;
  }
  return Buffer.from(element.text.replace(/\s+/g, ""), "base64");
}

export interface SoapResponse {
  body: string | Buffer;
  contentType: string;
}

/**
 * Wrap a response body. Documents to send as MTOM attachments are written into the body as
 * xop:Include placeholders by `attach`.
 */
export function soapResponse(
  request: { messageId?: string; mtom: boolean },
  action: string,
  build: (attach: (data: Buffer) => string) => string,
): SoapResponse {
  const attachments: Array<{ id: string; data: Buffer }> = [];
  const attach = (data: Buffer) => {
    if (!request.mtom) return data.toString("base64");
    const id = `${randomUUID()}@emuhealth`;
    attachments.push({ id, data });
    return el("xop:Include", { "xmlns:xop": XOP, href: `cid:${encodeURIComponent(id)}` });
  };
  const content = build(attach);
  const envelope = el(
    "s:Envelope",
    { "xmlns:s": SOAP, "xmlns:a": WSA },
    el(
      "s:Header",
      {},
      textEl("a:Action", action, { "s:mustUnderstand": "1" }),
      request.messageId ? textEl("a:RelatesTo", request.messageId) : undefined,
    ),
    el("s:Body", {}, content),
  );
  if (!request.mtom) return { body: envelope, contentType: `application/soap+xml; charset=UTF-8; action="${action}"` };
  const boundary = `MIMEBoundary_${randomUUID().replace(/-/g, "")}`;
  const rootId = `root.${randomUUID()}@emuhealth`;
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/xop+xml; charset=UTF-8; type="application/soap+xml"\r\nContent-Transfer-Encoding: binary\r\nContent-ID: <${rootId}>\r\n\r\n${envelope}\r\n`,
    ),
  ];
  for (const a of attachments)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nContent-ID: <${a.id}>\r\n\r\n`,
      ),
      a.data,
      Buffer.from("\r\n"),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/related; boundary="${boundary}"; type="application/xop+xml"; start="<${rootId}>"; start-info="application/soap+xml"; action="${action}"`,
  };
}

export function faultResponse(request: { messageId?: string } | undefined, fault: SoapFault): SoapResponse {
  return soapResponse(
    { messageId: request?.messageId, mtom: false },
    "http://www.w3.org/2005/08/addressing/soap/fault",
    () =>
      el(
        "s:Fault",
        {},
        el("s:Code", {}, textEl("s:Value", `s:${fault.code}`)),
        el("s:Reason", {}, textEl("s:Text", fault.message, { "xml:lang": "en" })),
      ),
  );
}
