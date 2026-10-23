import { createHash } from "node:crypto";

// A small DICOM Part 10 codec: enough to write synthetic instances (Explicit VR Little Endian) and to read the
// attributes DICOMweb needs from uploaded files in Explicit or Implicit VR Little Endian, skipping sequences.

export const EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
export const IMPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2";
const IMPLEMENTATION_CLASS_UID = "2.25.130612946016123178374119052512018318713";

export interface Element {
  vr: string;
  /** Strings for text VRs, numbers for US/UL/SS/SL, bytes for OB/OW/UN. */
  value: string[] | number[] | Uint8Array;
}
export type Dataset = Map<string, Element>;

/** A DICOM UID under 2.25 (UUID derived), from a stable key. */
export function uidFor(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  return `2.25.${BigInt(`0x${hex}`).toString()}`;
}

const LONG_VRS = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "SQ", "UT", "UN", "UC", "UR", "SV", "UV"]);
const NUMERIC_VRS: Record<string, number> = { US: 2, SS: 2, UL: 4, SL: 4 };

/** VRs of the attributes the emulator reads, for Implicit VR files. */
const DICTIONARY: Record<string, string> = {
  "00080016": "UI",
  "00080018": "UI",
  "00080020": "DA",
  "00080030": "TM",
  "00080050": "SH",
  "00080060": "CS",
  "00080090": "PN",
  "00081030": "LO",
  "0008103E": "LO",
  "00100010": "PN",
  "00100020": "LO",
  "00100030": "DA",
  "00100040": "CS",
  "0020000D": "UI",
  "0020000E": "UI",
  "00200010": "SH",
  "00200011": "IS",
  "00200013": "IS",
  "00280002": "US",
  "00280004": "CS",
  "00280008": "IS",
  "00280010": "US",
  "00280011": "US",
  "00280100": "US",
  "00280101": "US",
  "00280102": "US",
  "00280103": "US",
  "7FE00010": "OW",
  "00020010": "UI",
};

const tagKey = (group: number, element: number) =>
  `${group.toString(16).padStart(4, "0")}${element.toString(16).padStart(4, "0")}`.toUpperCase();

function encodeValue(element: Element): Buffer {
  if (element.value instanceof Uint8Array) {
    const bytes = Buffer.from(element.value);
    return bytes.length % 2 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
  }
  const size = NUMERIC_VRS[element.vr];
  if (size) {
    const buf = Buffer.alloc(size * element.value.length);
    (element.value as number[]).forEach((n, i) => {
      if (element.vr === "US") buf.writeUInt16LE(n, i * 2);
      else if (element.vr === "SS") buf.writeInt16LE(n, i * 2);
      else if (element.vr === "UL") buf.writeUInt32LE(n, i * 4);
      else buf.writeInt32LE(n, i * 4);
    });
    return buf;
  }
  const text = (element.value as Array<string | number>).map(String).join("\\");
  const bytes = Buffer.from(text, "latin1");
  if (bytes.length % 2 === 0) return bytes;
  return Buffer.concat([bytes, Buffer.from(element.vr === "UI" ? "\0" : " ", "latin1")]);
}

function encodeElement(tag: string, element: Element): Buffer {
  const value = encodeValue(element);
  const group = parseInt(tag.slice(0, 4), 16);
  const el = parseInt(tag.slice(4), 16);
  const long = LONG_VRS.has(element.vr);
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(el, 2);
  header.write(element.vr, 4, "latin1");
  if (long) header.writeUInt32LE(value.length, 8);
  else header.writeUInt16LE(value.length, 6);
  return Buffer.concat([header, value]);
}

/** Write a Part 10 file in Explicit VR Little Endian. */
export function writePart10(dataset: Dataset): Buffer {
  const sopClass = (dataset.get("00080016")?.value as string[] | undefined)?.[0] ?? "";
  const sopInstance = (dataset.get("00080018")?.value as string[] | undefined)?.[0] ?? "";
  const meta: Array<[string, Element]> = [
    ["00020001", { vr: "OB", value: new Uint8Array([0, 1]) }],
    ["00020002", { vr: "UI", value: [sopClass] }],
    ["00020003", { vr: "UI", value: [sopInstance] }],
    ["00020010", { vr: "UI", value: [EXPLICIT_VR_LITTLE_ENDIAN] }],
    ["00020012", { vr: "UI", value: [IMPLEMENTATION_CLASS_UID] }],
    ["00020013", { vr: "SH", value: ["EMUHEALTH"] }],
  ];
  const metaBody = Buffer.concat(meta.map(([tag, e]) => encodeElement(tag, e)));
  const groupLength = encodeElement("00020000", { vr: "UL", value: [metaBody.length] });
  const body = Buffer.concat(
    [...dataset.entries()]
      .filter(([tag]) => !tag.startsWith("0002"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, e]) => encodeElement(tag, e)),
  );
  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM", "latin1"), groupLength, metaBody, body]);
}

export class DicomParseError extends Error {}

/** Read a Part 10 file. Sequences are skipped; pixel data is kept as bytes. */
export function readPart10(bytes: Uint8Array): Dataset {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 132 || buf.toString("latin1", 128, 132) !== "DICM")
    throw new DicomParseError("Not a DICOM Part 10 file (no DICM prefix)");
  const dataset: Dataset = new Map();
  let pos = 132;
  // File meta information is always Explicit VR Little Endian.
  while (pos + 8 <= buf.length && buf.readUInt16LE(pos) === 0x0002) pos = readElement(buf, pos, true, dataset);
  const syntax = (dataset.get("00020010")?.value as string[] | undefined)?.[0];
  if (syntax !== EXPLICIT_VR_LITTLE_ENDIAN && syntax !== IMPLICIT_VR_LITTLE_ENDIAN)
    throw new DicomParseError(
      `Unsupported transfer syntax ${syntax ?? "(none)"}; use Explicit or Implicit VR Little Endian`,
    );
  const explicit = syntax === EXPLICIT_VR_LITTLE_ENDIAN;
  while (pos + 8 <= buf.length) pos = readElement(buf, pos, explicit, dataset);
  return dataset;
}

const UNDEFINED = 0xffffffff;

/** Skip an undefined length sequence or item, returning the position after its delimiter. */
function skipUndefined(buf: Buffer, pos: number, explicit: boolean): number {
  while (pos + 8 <= buf.length) {
    const group = buf.readUInt16LE(pos);
    const el = buf.readUInt16LE(pos + 2);
    if (group === 0xfffe) {
      const length = buf.readUInt32LE(pos + 4);
      pos += 8;
      if (el === 0xe0dd || el === 0xe00d) return pos; // sequence or item delimiter
      if (el === 0xe000) pos = length === UNDEFINED ? skipUndefined(buf, pos, explicit) : pos + length; // item
      continue;
    }
    pos = readElement(buf, pos, explicit, undefined);
  }
  return pos;
}

function readElement(buf: Buffer, pos: number, explicit: boolean, out: Dataset | undefined): number {
  const group = buf.readUInt16LE(pos);
  const el = buf.readUInt16LE(pos + 2);
  const tag = tagKey(group, el);
  let vr: string;
  let length: number;
  let start: number;
  const vrText = buf.toString("latin1", pos + 4, pos + 6);
  if (explicit && /^[A-Z]{2}$/.test(vrText)) {
    vr = vrText;
    if (LONG_VRS.has(vr)) {
      length = buf.readUInt32LE(pos + 8);
      start = pos + 12;
    } else {
      length = buf.readUInt16LE(pos + 6);
      start = pos + 8;
    }
  } else {
    vr = DICTIONARY[tag] ?? "UN";
    length = buf.readUInt32LE(pos + 4);
    start = pos + 8;
  }
  if (length === UNDEFINED) return skipUndefined(buf, start, explicit);
  const end = start + length;
  if (end > buf.length) throw new DicomParseError(`Element ${tag} runs past the end of the file`);
  if (out && vr !== "SQ") {
    const raw = buf.subarray(start, end);
    const size = NUMERIC_VRS[vr];
    let value: Element["value"];
    if (size) {
      const numbers: number[] = [];
      for (let i = 0; i + size <= raw.length; i += size)
        numbers.push(
          vr === "US"
            ? raw.readUInt16LE(i)
            : vr === "SS"
              ? raw.readInt16LE(i)
              : vr === "UL"
                ? raw.readUInt32LE(i)
                : raw.readInt32LE(i),
        );
      value = numbers;
    } else if (LONG_VRS.has(vr) && !["UT", "UC", "UR"].includes(vr)) value = new Uint8Array(raw);
    else
      value = raw
        .toString("latin1")
        .replace(/[\0 ]+$/, "")
        .split("\\");
    out.set(tag, { vr, value });
  }
  return end;
}

/** The first string value of an attribute. */
export const str = (ds: Dataset, tag: string): string | undefined => {
  const v = ds.get(tag)?.value;
  return Array.isArray(v) && v.length ? String(v[0]) : undefined;
};

/** The DICOM JSON model of a dataset (PS3.18 Annex F), with pixel data as a BulkDataURI. */
export function toDicomJson(ds: Dataset, bulkDataUri?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tag, e] of [...ds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (tag.startsWith("0002")) continue;
    if (e.value instanceof Uint8Array) {
      if (tag === "7FE00010" && bulkDataUri) out[tag] = { vr: e.vr, BulkDataURI: bulkDataUri };
      continue;
    }
    const values = e.value as Array<string | number>;
    if (values.length === 0 || (values.length === 1 && values[0] === "")) {
      out[tag] = { vr: e.vr };
      continue;
    }
    if (e.vr === "PN") out[tag] = { vr: e.vr, Value: values.map((v) => ({ Alphabetic: String(v) })) };
    else if (e.vr === "IS" || e.vr === "DS") out[tag] = { vr: e.vr, Value: values.map(Number) };
    else out[tag] = { vr: e.vr, Value: values };
  }
  return out;
}

// A minimal grayscale PNG encoder for rendered frames.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function grayscalePng(
  pixels: Uint8Array,
  columns: number,
  rows: number,
  deflate: (b: Buffer) => Buffer,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(columns, 0);
  header.writeUInt32BE(rows, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const raw = Buffer.alloc((columns + 1) * rows);
  for (let y = 0; y < rows; y++) {
    raw[y * (columns + 1)] = 0; // filter: none
    Buffer.from(pixels.subarray(y * columns, (y + 1) * columns)).copy(raw, y * (columns + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
