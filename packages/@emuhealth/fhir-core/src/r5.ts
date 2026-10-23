import type { FhirResource } from "./store.js";

// Converts the generated R4 records to FHIR R5 for the elements they use. It is not a general R4 to R5
// converter: resources loaded from config or created over the API are stored as given.

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
    ...(cls ? { class: [{ coding: [cls] }] } : {}),
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
  return {
    ...rest,
    ...(context?.encounter ? { context: context.encounter } : {}),
    ...(context?.period ? { period: context.period } : {}),
    content: (content ?? []).map(({ format, ...c }: Json) => ({
      ...c,
      ...(format ? { profile: [{ valueCoding: format }] } : {}),
    })),
  };
}

function endpoint(r: Json): Json {
  const { connectionType, payloadType, ...rest } = r;
  return {
    ...rest,
    ...(connectionType ? { connectionType: [{ coding: [connectionType] }] } : {}),
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
      ? { participant: participant.map(({ role, ...p }: Json) => ({ ...p, ...(role?.[0] ? { role: role[0] } : {}) })) }
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
            ...(manifestation ? { manifestation: manifestation.map((concept: Json) => ({ concept })) } : {}),
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
      ...(type ? { type: [type] } : {}),
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

/** Generated records in the shape of the given FHIR version. R4B uses the R4 shapes for these resources. */
export function recordsForVersion(resources: FhirResource[], version: string): FhirResource[] {
  return version === "5.0.0" ? toR5(resources) : resources;
}
