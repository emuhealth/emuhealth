import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import {
  build,
  components,
  deframe,
  frame,
  get,
  hl7Time,
  Hl7ParseError,
  msh,
  parseMessage,
  repetitions,
  segment,
  segments,
  type Message,
  type Segment,
} from "./hl7.js";

export * from "./hl7.js";

/** HL7 v2 emulator: an MLLP listener and an HTTP API that acknowledge messages and keep a synthetic patient registry. */
export interface Hl7v2SeedConfig {
  port?: number;
  /** The MLLP listener: port (default 2575) and host, or false to turn it off. */
  mllp?: { port?: number; host?: string } | false;
  /** Seed the synthetic patients (default true). */
  generate?: boolean;
  /** Extra synthetic patients. */
  patients?: Array<Partial<Patient> & { mrn: string }>;
}

export interface Visit {
  visitNumber: string;
  patientClass: string;
  location: string;
  attendingDoctor: string;
  admitted?: string;
  discharged?: string;
  status: "active" | "discharged" | "cancelled";
}

export interface Observation {
  setId: string;
  valueType: string;
  code: string;
  text: string;
  system: string;
  value: string;
  units: string;
  referenceRange: string;
  abnormalFlags: string;
  status: string;
  time: string;
  order?: string;
}

export interface Order {
  placerNumber: string;
  fillerNumber: string;
  control: string;
  code: string;
  text: string;
  system: string;
  status: string;
  time: string;
}

export interface Patient {
  mrn: string;
  identifiers: Array<{ id: string; authority: string; type: string }>;
  family: string;
  given: string;
  birthDate: string;
  sex: string;
  address: string;
  phone: string;
  visits: Visit[];
  observations: Observation[];
  orders: Order[];
  mergedInto?: string;
  updated: string;
}

export interface StoredMessage {
  id: string;
  direction: "inbound" | "outbound";
  received: string;
  type: string;
  controlId: string;
  ackCode: string;
  error?: string;
  raw: string;
  ack: string;
  peer?: string;
}

const MESSAGES_KEY = "hl7v2.messages";
const PATIENTS_KEY = "hl7v2.patients";
const SERVICE_LABEL = "HL7 v2";
const ER7 = "x-application/hl7-v2+er7";
const MAX_MESSAGES = 1000;
/** The MLLP port per store, kept outside the store so it survives reset. */
const mllpPorts = new WeakMap<Store, number>();

const SYNTHETIC_PATIENTS: Array<Pick<Patient, "mrn" | "family" | "given" | "birthDate" | "sex" | "address">> = [
  {
    mrn: "syn-patient-001",
    family: "SYNTHETIC",
    given: "AVERY",
    birthDate: "19680412",
    sex: "F",
    address: "100 SAMPLE ST^^SPRINGFIELD^IL^62701",
  },
  {
    mrn: "syn-patient-002",
    family: "SYNTHETIC",
    given: "JORDAN",
    birthDate: "19790903",
    sex: "M",
    address: "200 EXAMPLE AVE^^MADISON^WI^53703",
  },
  {
    mrn: "syn-patient-003",
    family: "SYNTHETIC",
    given: "MORGAN",
    birthDate: "19550127",
    sex: "F",
    address: "300 FICTION RD^^COLUMBUS^OH^43215",
  },
  {
    mrn: "syn-patient-004",
    family: "SYNTHETIC",
    given: "RILEY",
    birthDate: "20240610",
    sex: "M",
    address: "400 PLACEHOLDER LN^^DENVER^CO^80202",
  },
  {
    mrn: "syn-patient-005",
    family: "SYNTHETIC",
    given: "CASEY",
    birthDate: "19910218",
    sex: "U",
    address: "500 TEST BLVD^^PORTLAND^OR^97201",
  },
];

function messages(store: Store): StoredMessage[] {
  let list = store.getData<StoredMessage[]>(MESSAGES_KEY);
  if (!list) {
    list = [];
    store.setData(MESSAGES_KEY, list);
  }
  return list;
}

function patients(store: Store): Map<string, Patient> {
  let map = store.getData<Map<string, Patient>>(PATIENTS_KEY);
  if (!map) {
    map = new Map();
    store.setData(PATIENTS_KEY, map);
  }
  return map;
}

function newPatient(p: Partial<Patient> & { mrn: string }): Patient {
  return {
    identifiers: [{ id: p.mrn, authority: "EMUHEALTH", type: "MR" }],
    family: "",
    given: "",
    birthDate: "",
    sex: "",
    address: "",
    phone: "",
    visits: [],
    observations: [],
    orders: [],
    updated: new Date().toISOString(),
    ...p,
  };
}

function seedPatients(store: Store): void {
  const map = patients(store);
  for (const p of SYNTHETIC_PATIENTS) map.set(p.mrn, newPatient(p));
}

export function seedFromConfig(store: Store, _baseUrl: string, config: Hl7v2SeedConfig): void {
  if (config.generate === false) patients(store).clear();
  if (config.mllp !== undefined && config.mllp !== false) {
    if (typeof config.mllp !== "object" || config.mllp === null)
      throw new Error("hl7v2.mllp must be an object or false");
    const port = config.mllp.port;
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
      throw new Error("hl7v2.mllp.port must be a port number");
  }
  if (config.patients === undefined) return;
  if (!Array.isArray(config.patients)) throw new Error("hl7v2.patients must be an array");
  for (const [i, p] of config.patients.entries()) {
    if (typeof p?.mrn !== "string" || !p.mrn) throw new Error(`hl7v2.patients[${i}].mrn is required`);
    patients(store).set(p.mrn, newPatient(p));
  }
}

// Message handling

class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function resolve(store: Store, mrn: string): Patient | undefined {
  let p = patients(store).get(mrn);
  for (let hops = 0; p?.mergedInto && hops < 10; hops++) p = patients(store).get(p.mergedInto);
  return p;
}

/** The patient's MRN from PID-3: the identifier typed MR, else the first one. */
function pidIdentifiers(m: Message, pid: Segment) {
  const ids = repetitions(m, pid, 3).map((rep) => {
    const c = components(m, rep);
    return { id: c[0] ?? "", authority: c[3] ?? "", type: c[4] ?? "" };
  });
  const usable = ids.filter((i) => i.id);
  if (!usable.length) throw new ApplicationError("PID-3 patient identifier list is empty", "101");
  return { ids: usable, mrn: (usable.find((i) => i.type === "MR") ?? usable[0]).id };
}

function upsertPatient(store: Store, m: Message): Patient {
  const pid = segment(m, "PID");
  if (!pid) throw new ApplicationError("Required segment PID is missing", "100");
  const { ids, mrn } = pidIdentifiers(m, pid);
  const existing = resolve(store, mrn);
  const p = existing ?? newPatient({ mrn, identifiers: ids });
  const set = <K extends keyof Patient>(key: K, value: Patient[K]) => {
    if (value !== "") p[key] = value;
  };
  set("family", get(m, pid, 5, 1));
  set("given", get(m, pid, 5, 2));
  set("birthDate", get(m, pid, 7).slice(0, 8));
  set("sex", get(m, pid, 8));
  const address = (pid.fields[11] ?? "").split(m.delimiters.repetition)[0];
  if (address) p.address = components(m, address).slice(0, 5).join("^");
  set("phone", get(m, pid, 13, 1));
  for (const id of ids)
    if (!p.identifiers.some((i) => i.id === id.id && i.authority === id.authority)) p.identifiers.push(id);
  p.updated = new Date().toISOString();
  patients(store).set(p.mrn, p);
  return p;
}

function visitFrom(m: Message): Partial<Visit> & { visitNumber: string } {
  const pv1 = segment(m, "PV1");
  const location = components(m, (pv1?.fields[3] ?? "").split(m.delimiters.repetition)[0] ?? "")
    .filter(Boolean)
    .join("-");
  const doctor = components(m, (pv1?.fields[7] ?? "").split(m.delimiters.repetition)[0] ?? "");
  return {
    visitNumber: get(m, pv1, 19, 1),
    patientClass: get(m, pv1, 2),
    location,
    attendingDoctor: [doctor[1], doctor[2]].filter(Boolean).join(", "),
    admitted: get(m, pv1, 44) || undefined,
    discharged: get(m, pv1, 45) || undefined,
  };
}

function findVisit(p: Patient, visitNumber: string): Visit | undefined {
  if (visitNumber) return p.visits.find((v) => v.visitNumber === visitNumber);
  return [...p.visits].reverse().find((v) => v.status === "active");
}

function applyAdt(store: Store, m: Message, trigger: string): void {
  if (trigger === "A40") {
    const pid = segment(m, "PID");
    const mrg = segment(m, "MRG");
    if (!pid || !mrg) throw new ApplicationError("A40 needs PID and MRG segments", "100");
    const prior = get(m, mrg, 1, 1);
    const source = patients(store).get(prior);
    if (!source) throw new ApplicationError(`Unknown prior patient ${prior}`, "204");
    const target = upsertPatient(store, m);
    if (target.mrn === source.mrn) throw new ApplicationError("MRG-1 names the surviving patient", "103");
    target.visits.push(...source.visits);
    target.observations.push(...source.observations);
    target.orders.push(...source.orders);
    for (const id of source.identifiers)
      if (!target.identifiers.some((i) => i.id === id.id)) target.identifiers.push(id);
    Object.assign(source, {
      visits: [],
      observations: [],
      orders: [],
      mergedInto: target.mrn,
      updated: new Date().toISOString(),
    });
    return;
  }
  const p = upsertPatient(store, m);
  const v = visitFrom(m);
  const existing = findVisit(p, v.visitNumber);
  const now = hl7Time();
  switch (trigger) {
    case "A01":
    case "A04":
    case "A05": {
      const visit: Visit = {
        patientClass: v.patientClass ?? "",
        location: v.location ?? "",
        attendingDoctor: v.attendingDoctor ?? "",
        visitNumber: v.visitNumber || `V${randomBytes(4).toString("hex").toUpperCase()}`,
        admitted: v.admitted ?? now,
        status: "active",
      };
      if (existing && v.visitNumber) Object.assign(existing, visit);
      else p.visits.push(visit);
      return;
    }
    case "A02":
    case "A06":
    case "A07":
      if (!existing) throw new ApplicationError("No active visit to update", "204");
      if (v.location) existing.location = v.location;
      if (v.patientClass) existing.patientClass = v.patientClass;
      return;
    case "A03":
      if (!existing) throw new ApplicationError("No active visit to discharge", "204");
      existing.status = "discharged";
      existing.discharged = v.discharged ?? now;
      return;
    case "A11":
      if (!existing) throw new ApplicationError("No visit to cancel", "204");
      existing.status = "cancelled";
      return;
    case "A13":
      if (!existing) throw new ApplicationError("No visit to reopen", "204");
      existing.status = "active";
      existing.discharged = undefined;
      return;
    default:
      // A08, A28, A31 and other demographic updates only touch PID.
      if (existing && v.location) existing.location = v.location;
  }
}

function applyOru(store: Store, m: Message): void {
  const p = upsertPatient(store, m);
  let order: string | undefined;
  for (const seg of m.segments) {
    if (seg.name === "OBR") order = get(m, seg, 2, 1) || get(m, seg, 3, 1) || undefined;
    if (seg.name !== "OBX") continue;
    const value = repetitions(m, seg, 5)
      .map((r) => components(m, r).filter(Boolean).join(" "))
      .join(", ");
    p.observations.push({
      setId: get(m, seg, 1),
      valueType: get(m, seg, 2),
      code: get(m, seg, 3, 1),
      text: get(m, seg, 3, 2),
      system: get(m, seg, 3, 3),
      value,
      units: get(m, seg, 6, 1),
      referenceRange: get(m, seg, 7),
      abnormalFlags: get(m, seg, 8),
      status: get(m, seg, 11),
      time: get(m, seg, 14) || hl7Time(),
      order,
    });
  }
}

function applyOrder(store: Store, m: Message): void {
  const p = upsertPatient(store, m);
  const orcs = segments(m, "ORC");
  const obrs = segments(m, "OBR");
  if (!orcs.length && !obrs.length) throw new ApplicationError("Order messages need ORC or OBR segments", "100");
  const count = Math.max(orcs.length, obrs.length);
  for (let i = 0; i < count; i++) {
    const orc = orcs[i];
    const obr = obrs[i];
    const placer = get(m, orc, 2, 1) || get(m, obr, 2, 1);
    const control = get(m, orc, 1) || "NW";
    const existing = placer ? p.orders.find((o) => o.placerNumber === placer) : undefined;
    const status =
      control === "CA" || control === "OC" ? "CA" : control === "SC" ? get(m, orc, 5) || "SC" : get(m, orc, 5) || "IP";
    if (existing) {
      existing.control = control;
      existing.status = status;
      continue;
    }
    p.orders.push({
      placerNumber: placer,
      fillerNumber: get(m, orc, 3, 1) || get(m, obr, 3, 1),
      control,
      code: get(m, obr, 4, 1),
      text: get(m, obr, 4, 2),
      system: get(m, obr, 4, 3),
      status,
      time: get(m, orc, 9) || get(m, obr, 7) || hl7Time(),
    });
  }
}

function buildAck(m: Message | undefined, code: string, error?: { text: string; code: string }): string {
  const header = m ? segment(m, "MSH") : undefined;
  const field = (n: number, c?: number) => (m && header ? get(m, header, n, c) : "");
  const trigger = field(9, 2);
  const lines = [
    msh([
      "EMUHEALTH",
      "EMUHEALTH",
      field(3),
      field(4),
      hl7Time(),
      "",
      ["ACK", trigger, "ACK"],
      `ACK${randomBytes(6).toString("hex").toUpperCase()}`,
      field(11) || "P",
      field(12) || "2.5.1",
    ]),
    build("MSA", [code, field(10), error?.text]),
  ];
  if (error) lines.push(build("ERR", ["", "", [error.code, "", "HL70357"], "E", "", "", "", error.text]));
  return `${lines.join("\r")}\r`;
}

const HANDLED: Record<string, (store: Store, m: Message, trigger: string) => void> = {
  ADT: applyAdt,
  ORU: (store, m) => applyOru(store, m),
  ORM: (store, m) => applyOrder(store, m),
  OML: (store, m) => applyOrder(store, m),
};

/** Process one inbound message: apply it to the registry, record it, and return the ACK. */
export function receive(store: Store, raw: string, peer?: string): string {
  const record = (entry: Omit<StoredMessage, "id" | "received" | "direction" | "raw">) => {
    const list = messages(store);
    list.push({
      id: randomBytes(8).toString("hex"),
      direction: "inbound",
      received: new Date().toISOString(),
      raw,
      peer,
      ...entry,
    });
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  };
  let m: Message;
  try {
    m = parseMessage(raw);
  } catch (error) {
    if (!(error instanceof Hl7ParseError)) throw error;
    const ack = buildAck(undefined, "AR", { text: error.message, code: "100" });
    record({ type: "", controlId: "", ackCode: "AR", error: error.message, ack });
    return ack;
  }
  const header = segment(m, "MSH")!;
  const type = get(m, header, 9, 1);
  const trigger = get(m, header, 9, 2);
  const controlId = get(m, header, 10);
  const fullType = trigger ? `${type}^${trigger}` : type;
  let code = "AA";
  let error: { text: string; code: string } | undefined;
  if (!type) error = { text: "MSH-9 message type is required", code: "101" };
  else if (!controlId) error = { text: "MSH-10 message control ID is required", code: "101" };
  else if (!get(m, header, 12, 1)) error = { text: "MSH-12 version ID is required", code: "101" };
  if (error) code = "AR";
  else
    try {
      HANDLED[type]?.(store, m, trigger);
    } catch (e) {
      if (!(e instanceof ApplicationError)) throw e;
      code = "AE";
      error = { text: e.message, code: e.code };
    }
  const ack = buildAck(m, code, error);
  record({ type: fullType, controlId, ackCode: code, error: error?.text, ack });
  return ack;
}

/** Send a message to an MLLP receiver and wait for its acknowledgement. */
export function sendMllp(host: string, port: number, message: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host, port });
    let buffer: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No acknowledgement from ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(frame(message)));
    socket.on("data", (chunk) => {
      const { messages: got, rest } = deframe(Buffer.concat([buffer, chunk]));
      buffer = rest;
      if (got.length) {
        clearTimeout(timer);
        socket.end();
        resolvePromise(got[0]);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Start the MLLP listener. Each framed message gets a framed ACK on the same connection. */
export async function listen(context: {
  store: Store;
  config?: Record<string, unknown>;
  hostname?: string;
}): Promise<{ urls: string[]; close(): Promise<void> } | undefined> {
  const config = (context.config ?? {}) as Hl7v2SeedConfig;
  if (config.mllp === false) return undefined;
  const port = config.mllp?.port ?? 2575;
  const host = config.mllp?.host ?? context.hostname ?? "127.0.0.1";
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.on("data", (chunk) => {
      const { messages: got, rest } = deframe(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const raw of got) socket.write(frame(receive(context.store, raw, peer)));
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const actual = address && typeof address === "object" ? address.port : port;
  mllpPorts.set(context.store, actual);
  return {
    urls: [`mllp://${host === "0.0.0.0" ? "localhost" : host}:${actual}`],
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolvePromise());
      }),
  };
}

// Sample messages

function samplePid(p: Patient): string {
  return build("PID", [
    "1",
    "",
    [p.mrn, "", "", "EMUHEALTH", "MR"],
    "",
    [p.family, p.given],
    "",
    p.birthDate,
    p.sex,
    "",
    "",
    p.address.split("^"),
    "",
    p.phone,
  ]);
}

/** Field values by position (1 based), for building sparse segments. */
function at(values: Record<number, string | string[]>): Array<string | string[] | undefined> {
  const out: Array<string | string[] | undefined> = [];
  for (const [n, v] of Object.entries(values)) out[Number(n) - 1] = v;
  return Array.from(out);
}

export function sample(kind: string, p: Patient): string | undefined {
  const now = hl7Time();
  const control = `SYN${randomBytes(5).toString("hex").toUpperCase()}`;
  const header = (type: string[]) =>
    msh(["SYNTHETIC_EHR", "SYNTHETIC_HOSP", "EMUHEALTH", "EMUHEALTH", now, "", type, control, "P", "2.5.1"]);
  const visit = `V${p.mrn.replace(/\D/g, "")}01`;
  const pv1 = build(
    "PV1",
    at({
      1: "1",
      2: "I",
      3: ["4W", "401", "A", "SYNTHETIC_HOSP"],
      7: ["0000000001", "EXAMPLE", "DANA", "", "", "DR"],
      19: visit,
    }),
  );
  const evn = (trigger: string) => build("EVN", [trigger, now]);
  const lines: Record<string, string[]> = {
    "adt-a01": [header(["ADT", "A01", "ADT_A01"]), evn("A01"), samplePid(p), pv1],
    "adt-a03": [
      header(["ADT", "A03", "ADT_A03"]),
      evn("A03"),
      samplePid(p),
      build("PV1", at({ 1: "1", 2: "I", 19: visit, 45: now })),
    ],
    "adt-a08": [header(["ADT", "A08", "ADT_A01"]), evn("A08"), samplePid({ ...p, phone: "555-0100" }), pv1],
    "oru-r01": [
      header(["ORU", "R01", "ORU_R01"]),
      samplePid(p),
      build("OBR", ["1", "ORD1001", "LAB1001", ["24323-8", "Comprehensive metabolic panel", "LN"], "", "", now]),
      build("OBX", [
        "1",
        "NM",
        ["2345-7", "Glucose [Mass/volume] in Serum or Plasma", "LN"],
        "",
        "95",
        "mg/dL",
        "70-99",
        "N",
        "",
        "",
        "F",
        "",
        "",
        now,
      ]),
      build("OBX", [
        "2",
        "NM",
        ["2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "LN"],
        "",
        "0.9",
        "mg/dL",
        "0.6-1.3",
        "N",
        "",
        "",
        "F",
        "",
        "",
        now,
      ]),
    ],
    "orm-o01": [
      header(["ORM", "O01", "ORM_O01"]),
      samplePid(p),
      build("ORC", ["NW", "ORD2001", "", "", "SC", "", "", "", now]),
      build("OBR", ["1", "ORD2001", "", ["57021-8", "CBC W Auto Differential panel - Blood", "LN"]]),
    ],
  };
  return lines[kind]?.join("\r").concat("\r");
}

// HTTP API and inspector

function inspector(store: Store, tab: string): string {
  const tabs = [
    { id: "messages", label: `Messages (${messages(store).length})`, href: "/_inspector?tab=messages" },
    { id: "patients", label: `Patients (${patients(store).size})`, href: "/_inspector?tab=patients" },
  ];
  let body: string;
  if (tab === "patients") {
    const rows = [...patients(store).values()].map(
      (p) =>
        `<tr><td><a href="${escapeAttr(`/patients/${encodeURIComponent(p.mrn)}`)}">${escapeHtml(p.mrn)}</a></td><td>${escapeHtml(`${p.family}, ${p.given}`)}</td><td>${escapeHtml(p.birthDate)}</td><td>${escapeHtml(p.sex)}</td><td>${p.visits.filter((v) => v.status === "active").length}/${p.visits.length}</td><td>${p.observations.length}</td><td>${p.orders.length}</td><td>${p.mergedInto ? `<span class="badge">merged into ${escapeHtml(p.mergedInto)}</span>` : ""}</td></tr>`,
    );
    body = `<div class="inspector-section"><h2>Patients</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>MRN</th><th>name</th><th>birth date</th><th>sex</th><th>active visits</th><th>observations</th><th>orders</th><th></th></tr></thead><tbody>${
      rows.length ? rows.join("") : '<tr><td colspan="8"><div class="inspector-empty">No patients</div></td></tr>'
    }</tbody></table></div></div>`;
  } else {
    const rows = [...messages(store)]
      .reverse()
      .slice(0, 300)
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.received)}</td><td>${escapeHtml(m.direction)}</td><td><a href="${escapeAttr(`/messages/${m.id}`)}">${escapeHtml(m.type || "(unparsed)")}</a></td><td>${escapeHtml(m.controlId)}</td><td><span class="badge">${escapeHtml(m.ackCode)}</span></td><td>${escapeHtml(m.error ?? "")}</td></tr>`,
      );
    body = `<div class="inspector-section"><h2>Messages</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>time</th><th>direction</th><th>type</th><th>control ID</th><th>ack</th><th>error</th></tr></thead><tbody>${
      rows.length ? rows.join("") : '<tr><td colspan="6"><div class="inspector-empty">No messages yet</div></td></tr>'
    }</tbody></table></div></div>`;
  }
  return renderInspectorPage("HL7 v2 inspector", tabs, tab, body, SERVICE_LABEL);
}

export const hl7v2Plugin: ServicePlugin = {
  name: "hl7v2",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const er7 = (c: Context<AppEnv>, text: string, status: 200 | 400 = 200) =>
      c.body(text, status, { "Content-Type": `${ER7}; charset=utf-8` });

    app.post("/messages", async (c) => {
      const raw = await c.req.text();
      if (!raw.trim()) return c.json({ error: "The body must be an HL7 v2 message" }, 400);
      return er7(c, receive(store, raw, "http"));
    });
    app.get("/messages", (c) => {
      const p = new URL(c.req.url).searchParams;
      const type = p.get("type");
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 100) || 100, 1), MAX_MESSAGES);
      const list = messages(store)
        .filter((m) => !type || m.type === type || m.type.startsWith(`${type}^`))
        .slice(-limit)
        .reverse();
      return c.json({ messages: list });
    });
    app.get("/messages/:id", (c) => {
      const m = messages(store).find((x) => x.id === c.req.param("id"));
      return m ? c.json(m) : c.json({ error: "Message not found" }, 404);
    });
    app.delete("/messages", (c) => {
      messages(store).length = 0;
      return c.body(null, 204);
    });

    app.get("/patients", (c) => c.json({ patients: [...patients(store).values()] }));
    app.get("/patients/:mrn", (c) => {
      const p = patients(store).get(c.req.param("mrn"));
      return p ? c.json(p) : c.json({ error: "Patient not found" }, 404);
    });

    app.get("/samples/:kind", (c) => {
      const mrn = new URL(c.req.url).searchParams.get("patient") ?? "syn-patient-001";
      const p = patients(store).get(mrn) ?? newPatient({ mrn, family: "SYNTHETIC", given: "SAMPLE" });
      const text = sample(c.req.param("kind"), p);
      return text
        ? er7(c, text)
        : c.json({ error: "Unknown sample; use adt-a01, adt-a03, adt-a08, oru-r01, or orm-o01" }, 404);
    });

    app.post("/send", async (c) => {
      let body: { host?: unknown; port?: unknown; message?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "The body must be JSON with port and message" }, 400);
      }
      const host = typeof body.host === "string" && body.host ? body.host : "127.0.0.1";
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof body.message !== "string" || !body.message)
        return c.json({ error: "port and message are required" }, 400);
      const raw = body.message.replace(/\r\n|\n/g, "\r");
      let header: Segment | undefined;
      let parsed: Message | undefined;
      try {
        parsed = parseMessage(raw);
        header = segment(parsed, "MSH");
      } catch (error) {
        if (error instanceof Hl7ParseError) return c.json({ error: error.message }, 400);
        throw error;
      }
      const entry: StoredMessage = {
        id: randomBytes(8).toString("hex"),
        direction: "outbound",
        received: new Date().toISOString(),
        type: [get(parsed, header, 9, 1), get(parsed, header, 9, 2)].filter(Boolean).join("^"),
        controlId: get(parsed, header, 10),
        ackCode: "",
        raw,
        ack: "",
        peer: `${host}:${port}`,
      };
      messages(store).push(entry);
      try {
        entry.ack = await sendMllp(host, port, raw);
        const ack = parseMessage(entry.ack);
        entry.ackCode = get(ack, segment(ack, "MSA"), 1);
        entry.error = get(ack, segment(ack, "MSA"), 3) || undefined;
        return c.json({ ackCode: entry.ackCode, ack: entry.ack });
      } catch (error) {
        entry.error = (error as Error).message;
        return c.json({ error: entry.error }, 502);
      }
    });

    app.get("/mllp", (c) => c.json({ port: mllpPorts.get(store) ?? null }));
    app.get("/_inspector", (c) =>
      c.html(inspector(store, new URL(c.req.url).searchParams.get("tab") === "patients" ? "patients" : "messages")),
    );
  },
  seed(store: Store): void {
    seedPatients(store);
  },
};

export default hl7v2Plugin;
