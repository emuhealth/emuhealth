import { FhirError } from "./outcome.js";
import type { FhirResource } from "./store.js";

// Converts R4 shapes to FHIR R5 for the elements the generator uses. Each converter changes only elements still in
// their R4 form, so R5 input passes through unchanged. It runs on generated records and, on an R5 server, on every
// create and update (r5Write), which also rejects R4 elements R5 removed.

type Json = Record<string, any>;

const ENCOUNTER_STATUS: Record<string, string> = {
  planned: "planned",
  arrived: "in-progress",
  triaged: "in-progress",
  "in-progress": "in-progress",
  onleave: "on-hold",
  finished: "completed",
  cancelled: "cancelled",
  "entered-in-error": "entered-in-error",
  unknown: "unknown",
};

function encounter(r: Json): Json {
  const { class: cls, period, reasonCode, reasonReference, hospitalization, participant, status, ...rest } = r;
  return {
    ...rest,
    status: ENCOUNTER_STATUS[status] ?? status,
    ...(cls ? { class: Array.isArray(cls) ? cls : [{ coding: [cls] }] } : {}),
    ...(participant
      ? {
          participant: participant.map(({ individual, ...p }: Json) => ({
            ...p,
            ...(individual ? { actor: individual } : {}),
          })),
        }
      : {}),
    ...(period ? { actualPeriod: period } : {}),
    ...(reasonCode || reasonReference
      ? {
          reason: [
            {
              value: [
                ...(reasonCode ?? []).map((concept: Json) => ({ concept })),
                ...(reasonReference ?? []).map((reference: Json) => ({ reference })),
              ],
            },
          ],
        }
      : {}),
    ...(hospitalization ? { admission: hospitalization } : {}),
  };
}

function medicationRequest(r: Json): Json {
  const { medicationCodeableConcept, medicationReference, reasonCode, reasonReference, reportedBoolean, ...rest } = r;
  return {
    ...rest,
    ...(medicationCodeableConcept ? { medication: { concept: medicationCodeableConcept } } : {}),
    ...(medicationReference ? { medication: { reference: medicationReference } } : {}),
    ...(reportedBoolean !== undefined ? { reported: reportedBoolean } : {}),
    ...(reasonCode || reasonReference
      ? {
          reason: [
            ...(reasonCode ?? []).map((concept: Json) => ({ concept })),
            ...(reasonReference ?? []).map((reference: Json) => ({ reference })),
          ],
        }
      : {}),
  };
}

function procedure(r: Json): Json {
  const { performedDateTime, performedPeriod, ...rest } = r;
  return {
    ...rest,
    ...(performedDateTime ? { occurrenceDateTime: performedDateTime } : {}),
    ...(performedPeriod ? { occurrencePeriod: performedPeriod } : {}),
  };
}

function documentReference(r: Json): Json {
  const { context, content, ...rest } = r;
  const r4Context = context && !Array.isArray(context);
  return {
    ...rest,
    ...(r4Context
      ? {
          ...(context.encounter ? { context: context.encounter } : {}),
          ...(context.period ? { period: context.period } : {}),
        }
      : context
        ? { context }
        : {}),
    ...(content
      ? {
          content: content.map(({ format, ...c }: Json) => ({
            ...c,
            ...(format ? { profile: [{ valueCoding: format }] } : {}),
          })),
        }
      : {}),
  };
}

function endpoint(r: Json): Json {
  const { connectionType, payloadType, ...rest } = r;
  return {
    ...rest,
    ...(connectionType
      ? { connectionType: Array.isArray(connectionType) ? connectionType : [{ coding: [connectionType] }] }
      : {}),
    ...(payloadType
      ? { payload: [{ type: payloadType.map((t: Json) => (t.text ? { ...t, text: t.text.replace("R4", "R5") } : t)) }] }
      : {}),
  };
}

function careTeam(r: Json): Json {
  const { participant, ...rest } = r;
  return {
    ...rest,
    ...(participant
      ? {
          participant: participant.map(({ role, ...p }: Json) => ({
            ...p,
            ...(Array.isArray(role) ? (role[0] ? { role: role[0] } : {}) : role ? { role } : {}),
          })),
        }
      : {}),
  };
}

function allergyIntolerance(r: Json): Json {
  const { reaction, ...rest } = r;
  return {
    ...rest,
    ...(reaction
      ? {
          reaction: reaction.map(({ manifestation, ...x }: Json) => ({
            ...x,
            ...(manifestation
              ? {
                  manifestation: manifestation.map((m: Json) => (m.concept || m.reference ? m : { concept: m })),
                }
              : {}),
          })),
        }
      : {}),
  };
}

/** R5 moves telecom, and on Organization the addresses, into ExtendedContactDetail entries. */
function contacts(r: Json, moveAddress: boolean): Json {
  const { telecom, address, ...rest } = r;
  const addresses: Json[] = moveAddress ? (address ?? []) : [];
  const contact: Json[] = addresses.map((a, i) => ({ ...(i === 0 && telecom ? { telecom } : {}), address: a }));
  if (telecom && contact.length === 0) contact.push({ telecom });
  return {
    ...rest,
    ...(!moveAddress && address ? { address } : {}),
    ...(contact.length ? { contact: [...(r.contact ?? []), ...contact] } : {}),
  };
}

/** R5 drops Device.patient; the link moves to a DeviceAssociation. */
function device(r: Json): Json[] {
  const { patient, type, distinctIdentifier: _distinct, udiCarrier, ...rest } = r;
  const out: Json[] = [
    {
      ...rest,
      // R5 requires the issuer; the generated UDIs are GS1 (application identifier 01).
      ...(udiCarrier
        ? {
            udiCarrier: udiCarrier.map((u: Json) => ({ issuer: "http://hl7.org/fhir/NamingSystem/gs1-di", ...u })),
          }
        : {}),
      ...(type ? { type: Array.isArray(type) ? type : [type] } : {}),
    },
  ];
  if (patient)
    out.push({
      resourceType: "DeviceAssociation",
      id: `${r.id}-association`,
      ...(r.meta ? { meta: r.meta } : {}),
      device: { reference: `Device/${r.id}` },
      subject: patient,
      status: { coding: [{ system: "http://hl7.org/fhir/deviceassociation-status", code: "implanted" }] },
    });
  return out;
}

export function toR5(resources: FhirResource[]): FhirResource[] {
  return resources.flatMap((r): FhirResource[] => {
    switch (r.resourceType) {
      case "Encounter":
        return [encounter(r) as FhirResource];
      case "MedicationRequest":
        return [medicationRequest(r) as FhirResource];
      case "Procedure":
        return [procedure(r) as FhirResource];
      case "DocumentReference":
        return [documentReference(r) as FhirResource];
      case "Endpoint":
        return [endpoint(r) as FhirResource];
      case "Device":
        return device(r) as FhirResource[];
      case "CareTeam":
        return [careTeam(r) as FhirResource];
      case "AllergyIntolerance":
        return [allergyIntolerance(r) as FhirResource];
      case "Organization":
        return [contacts(r, true) as FhirResource];
      case "PractitionerRole":
      case "Location":
        return [contacts(r, false) as FhirResource];
      default:
        return [r];
    }
  });
}

/** R4 elements R5 removed without a one to one replacement; writes that use them are rejected. */
const REMOVED: Record<string, Record<string, string>> = {
  Device: {
    patient: "link the patient with a DeviceAssociation",
    distinctIdentifier: "use biologicalSourceEvent",
  },
  Encounter: {
    statusHistory: "record status changes with EncounterHistory",
    classHistory: "record class changes with EncounterHistory",
  },
};

/**
 * Prepare a resource written to an R5 server: convert the R4 shapes toR5 knows and reject R4 elements R5 removed.
 * Device keeps its single resource here; generated devices get a DeviceAssociation from toR5 instead.
 */
export function r5Write(resource: FhirResource): FhirResource {
  const removed = Object.entries(REMOVED[resource.resourceType] ?? {}).filter(([key]) => key in resource);
  if (removed.length)
    throw new FhirError(
      400,
      "structure",
      `${resource.resourceType} ${removed.map(([key, fix]) => `${key} is not in FHIR R5 (${fix})`).join("; ")}`,
    );
  if (resource.resourceType === "CareTeam")
    for (const p of (resource.participant ?? []) as Json[])
      if (Array.isArray(p.role) && p.role.length > 1)
        throw new FhirError(400, "structure", "CareTeam.participant.role holds one CodeableConcept in FHIR R5");
  return toR5([resource])[0];
}

/** Generated records in the shape of the given FHIR version. R4B uses the R4 shapes for these resources. */
export function recordsForVersion(resources: FhirResource[], version: string): FhirResource[] {
  return version === "5.0.0" ? toR5(resources) : resources;
}
