import type { Store } from "@emulators/core";
import {
  FhirError,
  SYNTHETIC_TAG,
  getFhirStore,
  resolveAccess,
  type AccessGuard,
  type FhirResource,
  type FhirStore,
} from "@emuhealth/fhir-core";

// Epic-style scheduling: Schedules and free Slots for each practitioner, Appointment/$find to propose
// appointments in open slots, and Appointment/$book to book one.

const SLOT_MINUTES = 30;
const DAY = 86_400_000;

export interface SchedulingOptions {
  /** First day with slots (YYYY-MM-DD). Default: the day the emulator seeds. */
  startDate?: string;
  /** Weekdays with slots, starting at startDate. Default 10. */
  days?: number;
}

/** A Schedule per practitioner and 30 minute Slots from 09:00 to 16:00 UTC on weekdays. */
export function seedSchedules(store: Store, options: SchedulingOptions = {}): void {
  const fhir = getFhirStore(store);
  const start = options.startDate ? Date.parse(`${options.startDate}T00:00:00Z`) : startOfDay(Date.now());
  if (Number.isNaN(start)) throw new Error("epic.scheduling.startDate must be a date in YYYY-MM-DD form");
  const days = options.days ?? 10;
  if (!Number.isInteger(days) || days < 0 || days > 60)
    throw new Error("epic.scheduling.days must be an integer from 0 to 60");
  // Replace earlier generated schedules, so seeding twice does not double the slots.
  for (const type of ["Slot", "Schedule"])
    for (const resource of fhir.listCurrent(type)) if (resource.id?.startsWith("syn-")) fhir.purge(type, resource.id);
  const location = fhir.listCurrent("Location")[0];
  for (const practitioner of fhir.listCurrent("Practitioner")) {
    const scheduleId = `syn-schedule-${practitioner.id}`;
    fhir.update("Schedule", scheduleId, {
      resourceType: "Schedule",
      id: scheduleId,
      meta: { tag: [SYNTHETIC_TAG] },
      active: true,
      serviceType: [{ text: "Office visit" }],
      actor: [
        { reference: `Practitioner/${practitioner.id}` },
        ...(location ? [{ reference: `Location/${location.id}` }] : []),
      ],
    });
    let day = start;
    for (let added = 0; added < days; day += DAY) {
      const weekday = new Date(day).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      added++;
      for (let minute = 9 * 60; minute < 16 * 60; minute += SLOT_MINUTES) {
        const slotStart = day + minute * 60_000;
        const id = `syn-slot-${practitioner.id}-${new Date(slotStart).toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
        fhir.update("Slot", id, {
          resourceType: "Slot",
          id,
          meta: { tag: [SYNTHETIC_TAG] },
          schedule: { reference: `Schedule/${scheduleId}` },
          status: "free",
          start: iso(slotStart),
          end: iso(slotStart + SLOT_MINUTES * 60_000),
        });
      }
    }
  }
}

const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

type Parameter = { name: string; [key: string]: unknown };

function parameters(body: unknown): Parameter[] {
  const resource = body as { resourceType?: string; parameter?: Parameter[] } | undefined;
  if (resource?.resourceType !== "Parameters" || !Array.isArray(resource.parameter))
    throw new FhirError(400, "invalid", "The request body must be a Parameters resource");
  return resource.parameter;
}

function param(params: Parameter[], name: string): Parameter | undefined {
  return params.find((p) => p.name === name);
}

/** A patient id from valueReference ("Patient/x"), valueString, or valueId. */
function patientParam(params: Parameter[]): string | undefined {
  const p = param(params, "patient");
  if (!p) return undefined;
  const ref = (p.valueReference as { reference?: string } | undefined)?.reference;
  const raw = ref ?? (p.valueString as string | undefined) ?? (p.valueId as string | undefined);
  return raw?.replace(/^Patient\//, "");
}

function guardFor(store: Store, authorization: string | undefined): { fhir: FhirStore; guard: AccessGuard } {
  const fhir = getFhirStore(store);
  const guard = resolveAccess(store, authorization, {
    resolve: (type, id) => fhir.find(type, id),
    listCurrent: (type) => fhir.listCurrent(type),
  });
  return { fhir, guard };
}

function requirePatient(fhir: FhirStore, guard: AccessGuard, patientId: string | undefined): FhirResource {
  if (!patientId) throw new FhirError(400, "required", "The patient parameter is required");
  const patient = fhir.find("Patient", patientId);
  if (!patient || !guard.allows(patient, "r"))
    throw new FhirError(404, "not-found", `Patient/${patientId} is not known`);
  return patient;
}

function scheduleActors(fhir: FhirStore, slot: FhirResource): Array<{ reference: string }> {
  const scheduleRef = (slot.schedule as { reference?: string } | undefined)?.reference ?? "";
  const schedule = fhir.find("Schedule", scheduleRef.replace(/^Schedule\//, ""));
  return (schedule?.actor as Array<{ reference: string }> | undefined) ?? [];
}

function proposal(fhir: FhirStore, slot: FhirResource, patientId: string): FhirResource {
  return {
    resourceType: "Appointment",
    id: `proposed-${slot.id}`,
    status: "proposed",
    serviceType: [{ text: "Office visit" }],
    start: slot.start,
    end: slot.end,
    minutesDuration: SLOT_MINUTES,
    slot: [{ reference: `Slot/${slot.id}` }],
    participant: [
      { actor: { reference: `Patient/${patientId}` }, required: "required", status: "needs-action" },
      ...scheduleActors(fhir, slot).map((actor) => ({ actor, required: "required", status: "accepted" })),
    ],
  };
}

/** Appointment/$find: proposed appointments in free slots between startTime and endTime. */
export function findAppointments(
  store: Store,
  authorization: string | undefined,
  body: unknown,
  base: string,
): FhirResource {
  const params = parameters(body);
  const { fhir, guard } = guardFor(store, authorization);
  guard.require("Appointment", "s");
  const patient = requirePatient(fhir, guard, patientParam(params));
  const from = Date.parse(String(param(params, "startTime")?.valueDateTime ?? new Date().toISOString()));
  const to = param(params, "endTime")?.valueDateTime
    ? Date.parse(String(param(params, "endTime")!.valueDateTime))
    : from + 7 * DAY;
  if (Number.isNaN(from) || Number.isNaN(to))
    throw new FhirError(400, "invalid", "startTime and endTime must be dateTimes");
  const slots = fhir
    .listCurrent("Slot")
    .filter((slot) => slot.status === "free")
    .filter((slot) => Date.parse(String(slot.start)) >= from && Date.parse(String(slot.end)) <= to)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, 50);
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: slots.length,
    entry: slots.map((slot) => {
      const appointment = proposal(fhir, slot, patient.id!);
      return { fullUrl: `${base}/Appointment/${appointment.id}`, resource: appointment, search: { mode: "match" } };
    }),
  };
}

/** Appointment/$book: book a proposed appointment, taking its slot. */
export function bookAppointment(store: Store, authorization: string | undefined, body: unknown): FhirResource {
  const params = parameters(body);
  const { fhir, guard } = guardFor(store, authorization);
  guard.require("Appointment", "c");
  const appointmentParam = param(params, "appointment");
  const appointment = appointmentParam?.resource as FhirResource | undefined;
  const proposedId =
    (appointmentParam?.valueString as string | undefined) ??
    (appointmentParam?.valueReference as { reference?: string } | undefined)?.reference?.replace(/^Appointment\//, "");
  const slotRef =
    (appointment?.slot as Array<{ reference?: string }> | undefined)?.[0]?.reference ??
    (proposedId?.startsWith("proposed-") ? `Slot/${proposedId.slice("proposed-".length)}` : undefined);
  if (!slotRef)
    throw new FhirError(400, "required", "The appointment parameter must name a proposed appointment or slot");
  const slot = fhir.find("Slot", slotRef.replace(/^Slot\//, ""));
  if (!slot) throw new FhirError(404, "not-found", `${slotRef} is not known`);
  if (slot.status !== "free") throw new FhirError(409, "conflict", `${slotRef} is already booked`);
  const patientId =
    patientParam(params) ??
    (appointment?.participant as Array<{ actor?: { reference?: string } }> | undefined)
      ?.map((p) => p.actor?.reference ?? "")
      .find((r) => r.startsWith("Patient/"))
      ?.slice("Patient/".length);
  requirePatient(fhir, guard, patientId);
  const booked = proposal(fhir, slot, patientId!);
  delete booked.id;
  booked.status = "booked";
  booked.created = new Date().toISOString();
  booked.meta = { tag: [SYNTHETIC_TAG] };
  booked.participant = (booked.participant as Array<Record<string, unknown>>).map((p) => ({
    ...p,
    status: "accepted",
  }));
  const comment = param(params, "appointmentNote")?.valueString;
  if (typeof comment === "string") booked.comment = comment;
  guard.requireWritable(booked, "c");
  const result = fhir.create("Appointment", booked);
  fhir.update("Slot", slot.id!, { ...slot, status: "busy" });
  return result.resource;
}
