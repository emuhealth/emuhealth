import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  dicomwebPlugin,
  generateInstances,
  readPart10,
  seedFromConfig,
  uidFor,
  writePart10,
  type Dataset,
  type DicomwebSeedConfig,
} from "../index.js";

const base = "http://localhost:4124";

function startService(config?: DicomwebSeedConfig) {
  const app = new Hono();
  const store = new Store();
  dicomwebPlugin.register(app as never, store, new WebhookDispatcher(), base);
  dicomwebPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return (path: string, init?: RequestInit) => app.request(`${base}${path}`, init);
}

/** Split a multipart/related response into part bodies. */
async function parts(res: Response): Promise<Buffer[]> {
  const boundary = /boundary=([^;]+)/.exec(res.headers.get("content-type") ?? "")![1];
  const body = Buffer.from(await res.arrayBuffer());
  const out: Buffer[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delimiter);
  while (pos >= 0) {
    pos += delimiter.length;
    if (body.toString("latin1", pos, pos + 2) === "--") break;
    const start = body.indexOf("\r\n\r\n", pos) + 4;
    const next = body.indexOf(delimiter, start);
    out.push(body.subarray(start, next - 2));
    pos = next;
  }
  return out;
}

function stowBody(files: Buffer[], boundary = "stow-boundary") {
  const chunks: Buffer[] = [];
  for (const f of files)
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), f, Buffer.from("\r\n"));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: new Uint8Array(Buffer.concat(chunks)),
    headers: { "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` },
  };
}

function syntheticInstance(study: string, n: number): Dataset {
  const ds: Dataset = new Map();
  ds.set("00080016", { vr: "UI", value: ["1.2.840.10008.5.1.4.1.1.7"] });
  ds.set("00080018", { vr: "UI", value: [uidFor("test", "sop", n)] });
  ds.set("00080060", { vr: "CS", value: ["OT"] });
  ds.set("00100010", { vr: "PN", value: ["SYNTHETIC^UPLOAD"] });
  ds.set("00100020", { vr: "LO", value: ["syn-upload-1"] });
  ds.set("0020000D", { vr: "UI", value: [study] });
  ds.set("0020000E", { vr: "UI", value: [uidFor("test", "series")] });
  ds.set("00280002", { vr: "US", value: [1] });
  ds.set("00280004", { vr: "CS", value: ["MONOCHROME2"] });
  ds.set("00280010", { vr: "US", value: [2] });
  ds.set("00280011", { vr: "US", value: [2] });
  ds.set("00280100", { vr: "US", value: [8] });
  ds.set("7FE00010", { vr: "OB", value: new Uint8Array([0, 80, 160, 255]) });
  return ds;
}

describe("DICOM codec", () => {
  it("round trips a generated instance through Part 10", () => {
    const [ds] = generateInstances();
    const back = readPart10(writePart10(ds));
    for (const [tag, e] of ds) expect(back.get(tag)?.value, tag).toEqual(e.value);
    expect(back.get("00020010")?.value).toEqual(["1.2.840.10008.1.2.1"]);
  });

  it("generates the same synthetic studies for the same seed", () => {
    const a = generateInstances({ seed: "x", studies: 2 });
    const b = generateInstances({ seed: "x", studies: 2 });
    expect(a.map((d) => d.get("00080018")?.value)).toEqual(b.map((d) => d.get("00080018")?.value));
    expect(a.every((d) => String((d.get("00080018")?.value as string[])[0]).startsWith("2.25."))).toBe(true);
    expect(() => generateInstances({ studies: -1 })).toThrow(/studies/);
  });

  it("rejects files that are not Part 10", () => {
    expect(() => readPart10(new Uint8Array(200))).toThrow(/DICM/);
  });
});

describe("QIDO-RS", () => {
  it("searches studies with matching, computed attributes, and paging", async () => {
    const req = startService();
    const res = await req("/studies");
    expect(res.headers.get("content-type")).toContain("application/dicom+json");
    const studies = (await res.json()) as any[];
    expect(studies).toHaveLength(3);
    const mr = studies.find((s) => s["00080061"].Value.includes("MR"));
    expect(mr["00201206"].Value).toEqual([2]);
    expect(mr["00201208"].Value).toEqual([6]);
    expect(mr["00100010"].Value).toEqual([{ Alphabetic: "SYNTHETIC^JORDAN" }]);
    expect(mr["00081190"].Value[0]).toBe(`${base}/studies/${mr["0020000D"].Value[0]}`);

    expect(await (await req("/studies?PatientID=syn-patient-001")).json()).toHaveLength(1);
    expect(await (await req("/studies?ModalitiesInStudy=MR")).json()).toHaveLength(1);
    expect(await (await req("/studies?PatientName=synthetic*")).json()).toHaveLength(3);
    expect(await (await req("/studies?PatientName=jor&fuzzymatching=true")).json()).toHaveLength(1);
    expect(await (await req("/studies?StudyDate=20260101-20260131")).json()).toHaveLength(1);
    expect(await (await req("/studies?00080060=CT")).json()).toHaveLength(2);
    expect(await (await req("/studies?limit=1&offset=1")).json()).toHaveLength(1);
    expect((await req("/studies?Bogus=1")).status).toBe(400);
  });

  it("searches series and instances within a study", async () => {
    const req = startService();
    const [study] = (await (await req("/studies?ModalitiesInStudy=MR")).json()) as any[];
    const uid = study["0020000D"].Value[0];
    const series = (await (await req(`/studies/${uid}/series`)).json()) as any[];
    expect(series.map((s) => s["0008103E"].Value[0]).sort()).toEqual(["T1 AXIAL", "T2 AXIAL"]);
    expect(series[0]["00201209"].Value).toEqual([3]);
    const seriesUid = series[0]["0020000E"].Value[0];
    const inst = (await (await req(`/studies/${uid}/series/${seriesUid}/instances?includefield=all`)).json()) as any[];
    expect(inst).toHaveLength(3);
    expect(inst[0]["00280010"].Value).toEqual([64]);
    expect(inst[0]["00081030"]).toBeDefined();
    expect(await (await req("/instances?Modality=CT")).json()).toHaveLength(9);
    expect((await req("/studies/2.25.1/series")).status).toBe(404);
  });
});

describe("WADO-RS", () => {
  it("retrieves instances, metadata, frames, bulk data, and rendered PNGs", async () => {
    const req = startService({ generate: { studies: 1, instancesPerSeries: 2 } });
    const [study] = (await (await req("/studies")).json()) as any[];
    const uid = study["0020000D"].Value[0];

    const res = await req(`/studies/${uid}`, { headers: { Accept: 'multipart/related; type="application/dicom"' } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^multipart\/related; type="application\/dicom"; boundary=/);
    const files = await parts(res);
    expect(files).toHaveLength(2);
    const ds = readPart10(files[0]);
    expect(ds.get("0020000D")?.value).toEqual([uid]);
    expect((await req(`/studies/${uid}`, { headers: { Accept: "application/zip" } })).status).toBe(406);

    const metadata = (await (await req(`/studies/${uid}/metadata`)).json()) as any[];
    expect(metadata).toHaveLength(2);
    const bulk = metadata[0]["7FE00010"].BulkDataURI as string;
    expect(bulk).toMatch(/\/bulkdata\/7FE00010$/);
    const bulkParts = await parts(await req(bulk.slice(base.length)));
    expect(bulkParts[0]).toHaveLength(64 * 64 * 2);

    const path = bulk.slice(base.length).replace(/\/bulkdata\/7FE00010$/, "");
    const frame = await req(`${path}/frames/1`);
    expect(frame.headers.get("content-type")).toContain('type="application/octet-stream"');
    expect((await parts(frame))[0]).toHaveLength(64 * 64 * 2);
    expect((await req(`${path}/frames/2`)).status).toBe(404);

    const png = await req(`${path}/rendered`);
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(64);
    const idat = bytes.indexOf("IDAT");
    const raw = inflateSync(bytes.subarray(idat + 4, idat + 4 + bytes.readUInt32BE(idat - 4)));
    expect(raw).toHaveLength(65 * 64);
    expect(Math.max(...raw)).toBe(255);
    expect((await req(`${path}/frames/1/rendered`)).status).toBe(200);
  });
});

describe("STOW-RS", () => {
  it("stores instances, reports failures, and serves what it stored", async () => {
    const req = startService({ generate: false });
    const study = uidFor("test", "study");
    const good = writePart10(syntheticInstance(study, 1));
    const { body, headers } = stowBody([good, Buffer.from("not dicom")]);
    const res = await req("/studies", { method: "POST", body, headers });
    expect(res.status).toBe(202);
    const out = (await res.json()) as any;
    expect(out["00081199"].Value).toHaveLength(1);
    expect(out["00081198"].Value[0]["00081197"].Value).toEqual([0xc000]);
    expect(out["00081190"].Value).toEqual([`${base}/studies/${study}`]);

    const studies = (await (await req("/studies")).json()) as any[];
    expect(studies.map((s) => s["0020000D"].Value[0])).toEqual([study]);
    const [back] = await parts(await req(`/studies/${study}`));
    expect(Buffer.compare(back, good)).toBe(0);

    const wrong = stowBody([writePart10(syntheticInstance(uidFor("other"), 2))]);
    const conflict = await req(`/studies/${study}`, { method: "POST", ...wrong });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any)["00081198"].Value[0]["00081197"].Value).toEqual([0xa900]);

    expect(
      (await req("/studies", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status,
    ).toBe(415);
    expect((await req(`/studies/${study}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await req("/studies")).json()).toEqual([]);
  });

  it("requires the configured bearer token", async () => {
    const req = startService({ token: "synthetic-token" });
    expect((await req("/studies")).status).toBe(401);
    expect((await req("/studies", { headers: { Authorization: "Bearer synthetic-token" } })).status).toBe(200);
    expect((await req("/_inspector")).status).toBe(200);
  });
});
