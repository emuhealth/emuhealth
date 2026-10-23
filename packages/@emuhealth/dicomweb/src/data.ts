import { uidFor, type Dataset } from "./dicom.js";

export interface GenerateOptions {
  /** Number of studies (default 3). */
  studies?: number;
  /** Instances per series (default 3). */
  instancesPerSeries?: number;
  /** Seed for UIDs and image content (default "emuhealth"). */
  seed?: string;
}

export const SOP_CLASSES: Record<string, string> = {
  CT: "1.2.840.10008.5.1.4.1.1.2",
  MR: "1.2.840.10008.5.1.4.1.1.4",
  OT: "1.2.840.10008.5.1.4.1.1.7",
};

const PATIENTS = [
  { id: "syn-patient-001", name: "SYNTHETIC^AVERY", birth: "19680412", sex: "F" },
  { id: "syn-patient-002", name: "SYNTHETIC^JORDAN", birth: "19790903", sex: "M" },
  { id: "syn-patient-003", name: "SYNTHETIC^MORGAN", birth: "19550127", sex: "F" },
  { id: "syn-patient-004", name: "SYNTHETIC^RILEY", birth: "20240610", sex: "M" },
  { id: "syn-patient-005", name: "SYNTHETIC^CASEY", birth: "19910218", sex: "U" },
];

const PROTOCOLS = [
  { description: "CT CHEST WITHOUT CONTRAST", series: [{ modality: "CT", description: "AXIAL 5MM" }] },
  {
    description: "MRI BRAIN WITH AND WITHOUT CONTRAST",
    series: [
      { modality: "MR", description: "T1 AXIAL" },
      { modality: "MR", description: "T2 AXIAL" },
    ],
  },
  {
    description: "CT ABDOMEN PELVIS WITH CONTRAST",
    series: [
      { modality: "CT", description: "PORTAL VENOUS" },
      { modality: "CT", description: "DELAYED" },
    ],
  },
];

export const ROWS = 64;
export const COLUMNS = 64;

/** A synthetic phantom: an ellipse body with an inner disc whose size changes along the series. */
function phantom(modality: string, slice: number, count: number, sixteenBit: boolean): Uint8Array {
  const out = new Uint8Array(ROWS * COLUMNS * (sixteenBit ? 2 : 1));
  const view = new DataView(out.buffer);
  const t = count > 1 ? slice / (count - 1) : 0.5;
  const inner = 6 + Math.round(10 * Math.sin(Math.PI * t));
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLUMNS; x++) {
      const dx = x - COLUMNS / 2 + 0.5;
      const dy = y - ROWS / 2 + 0.5;
      const body = (dx * dx) / (28 * 28) + (dy * dy) / (22 * 22) <= 1;
      const disc = dx * dx + dy * dy <= inner * inner;
      let v = body ? (disc ? 0.85 : 0.4) : 0;
      if (body && modality === "MR") v += 0.1 * Math.sin((x + y + slice) / 3);
      const i = y * COLUMNS + x;
      if (sixteenBit) view.setUint16(i * 2, Math.round(v * 4000), true);
      else out[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  return out;
}

const text = (v: string) => [v];

/** Synthetic studies as DICOM datasets, one per instance. */
export function generateInstances(options: GenerateOptions = {}): Dataset[] {
  const studies = options.studies ?? 3;
  const perSeries = options.instancesPerSeries ?? 3;
  const seed = options.seed ?? "emuhealth";
  if (!Number.isInteger(studies) || studies < 0 || studies > 100)
    throw new Error("dicomweb.generate.studies must be an integer from 0 to 100");
  if (!Number.isInteger(perSeries) || perSeries < 1 || perSeries > 50)
    throw new Error("dicomweb.generate.instancesPerSeries must be an integer from 1 to 50");
  const out: Dataset[] = [];
  for (let s = 0; s < studies; s++) {
    const patient = PATIENTS[s % PATIENTS.length];
    const protocol = PROTOCOLS[s % PROTOCOLS.length];
    const study = uidFor(seed, "study", s);
    const date = `2026${String(1 + (s % 12)).padStart(2, "0")}${String(3 + ((s * 7) % 25)).padStart(2, "0")}`;
    protocol.series.forEach((series, n) => {
      const seriesUid = uidFor(seed, "series", s, n);
      const sixteenBit = series.modality === "CT";
      for (let i = 0; i < perSeries; i++) {
        const ds: Dataset = new Map();
        ds.set("00080016", { vr: "UI", value: text(SOP_CLASSES[series.modality]) });
        ds.set("00080018", { vr: "UI", value: text(uidFor(seed, "instance", s, n, i)) });
        ds.set("00080020", { vr: "DA", value: text(date) });
        ds.set("00080030", { vr: "TM", value: text(`${String(8 + (s % 9)).padStart(2, "0")}1500`) });
        ds.set("00080050", { vr: "SH", value: text(`SYNACC${String(s + 1).padStart(5, "0")}`) });
        ds.set("00080060", { vr: "CS", value: text(series.modality) });
        ds.set("00080090", { vr: "PN", value: text("SYNTHETIC^REFERRER") });
        ds.set("00081030", { vr: "LO", value: text(protocol.description) });
        ds.set("0008103E", { vr: "LO", value: text(series.description) });
        ds.set("00100010", { vr: "PN", value: text(patient.name) });
        ds.set("00100020", { vr: "LO", value: text(patient.id) });
        ds.set("00100030", { vr: "DA", value: text(patient.birth) });
        ds.set("00100040", { vr: "CS", value: text(patient.sex) });
        ds.set("0020000D", { vr: "UI", value: text(study) });
        ds.set("0020000E", { vr: "UI", value: text(seriesUid) });
        ds.set("00200010", { vr: "SH", value: text(String(s + 1)) });
        ds.set("00200011", { vr: "IS", value: text(String(n + 1)) });
        ds.set("00200013", { vr: "IS", value: text(String(i + 1)) });
        ds.set("00280002", { vr: "US", value: [1] });
        ds.set("00280004", { vr: "CS", value: text("MONOCHROME2") });
        ds.set("00280010", { vr: "US", value: [ROWS] });
        ds.set("00280011", { vr: "US", value: [COLUMNS] });
        ds.set("00280100", { vr: "US", value: [sixteenBit ? 16 : 8] });
        ds.set("00280101", { vr: "US", value: [sixteenBit ? 12 : 8] });
        ds.set("00280102", { vr: "US", value: [sixteenBit ? 11 : 7] });
        ds.set("00280103", { vr: "US", value: [0] });
        ds.set("7FE00010", {
          vr: sixteenBit ? "OW" : "OB",
          value: phantom(series.modality, i, perSeries, sixteenBit),
        });
        out.push(ds);
      }
    });
  }
  return out;
}
