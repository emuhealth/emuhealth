// An MLLP listener that turns ADT and ORU messages into FHIR Patients and Observations, then ACKs the sender.
import { createServer, type Server } from "node:net";
import { ack, component, deframe, frame, parse, segments, type Segment } from "./hl7.ts";

const MRN_SYSTEM = "urn:emuhealth:example:mrn";
const LOINC = "http://loinc.org";

export interface BridgeOptions {
  fhirBase: string;
}

async function fhir(options: BridgeOptions, method: string, path: string, body?: unknown) {
  const res = await fetch(`${options.fhirBase}/${path}`, {
    method,
    headers: { Accept: "application/fhir+json", ...(body ? { "Content-Type": "application/fhir+json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

const hl7Date = (value: string) =>
  value.length >= 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : undefined;
const hl7DateTime = (value: string) =>
  value.length >= 12
    ? `${hl7Date(value)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14) || "00"}Z`
    : hl7Date(value);
const GENDER: Record<string, string> = { F: "female", M: "male", O: "other", U: "unknown" };

/** Create or update the Patient for PID-3, keyed by MRN. */
async function upsertPatient(options: BridgeOptions, pid: Segment): Promise<string> {
  const mrn = component(pid[3], 1);
  if (!mrn) throw new Error("PID-3 has no MRN");
  const patient = {
    resourceType: "Patient",
    identifier: [{ system: MRN_SYSTEM, value: mrn }],
    name: [{ family: component(pid[5], 1), given: [component(pid[5], 2)].filter(Boolean) }],
    ...(hl7Date(pid[7] ?? "") ? { birthDate: hl7Date(pid[7]) } : {}),
    ...(GENDER[pid[8] ?? ""] ? { gender: GENDER[pid[8]] } : {}),
  };
  // Search, then update or create: works on servers without conditional update, which is optional in FHIR.
  const found = await fhir(options, "GET", `Patient?identifier=${encodeURIComponent(`${MRN_SYSTEM}|${mrn}`)}`);
  const id: string | undefined = found.entry?.find((e: any) => e.resource.resourceType === "Patient")?.resource.id;
  const saved = id
    ? await fhir(options, "PUT", `Patient/${id}`, { ...patient, id })
    : await fhir(options, "POST", "Patient", patient);
  return saved.id;
}

async function apply(options: BridgeOptions, message: Segment[]): Promise<void> {
  const msh = segments(message, "MSH")[0];
  const type = component(msh?.[9], 1);
  const pid = segments(message, "PID")[0];
  if (!pid) throw new Error("The message has no PID segment");
  const patientId = await upsertPatient(options, pid);
  if (type !== "ORU") return;
  for (const obx of segments(message, "OBX")) {
    const value = Number(obx[5]);
    const coding = {
      system: component(obx[3], 3) === "LN" ? LOINC : undefined,
      code: component(obx[3], 1),
      display: component(obx[3], 2),
    };
    await fhir(options, "POST", "Observation", {
      resourceType: "Observation",
      status: obx[11] === "F" ? "final" : "preliminary",
      category: [
        { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] },
      ],
      code: { coding: [coding], text: coding.display },
      subject: { reference: `Patient/${patientId}` },
      ...(hl7DateTime(obx[14] ?? "") ? { effectiveDateTime: hl7DateTime(obx[14]) } : {}),
      ...(obx[2] === "NM" && Number.isFinite(value)
        ? { valueQuantity: { value, unit: obx[6], system: "http://unitsofmeasure.org", code: obx[6] } }
        : { valueString: obx[5] }),
    });
  }
}

export function createBridge(options: BridgeOptions): Server {
  return createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    socket.on("data", (chunk) => {
      const { messages, rest } = deframe(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const raw of messages)
        queue = queue.then(async () => {
          const message = parse(raw);
          try {
            await apply(options, message);
            socket.write(frame(ack(message, "AA")));
          } catch (error) {
            socket.write(frame(ack(message, "AE", (error as Error).message.replace(/[|^~\\&\r\n]/g, " "))));
          }
        });
    });
  });
}
