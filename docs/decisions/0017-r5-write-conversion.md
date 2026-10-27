# 0017: R4 shaped writes on an R5 server

- Status: Accepted
- Date: 2026-10-24
- Refines: [0016](0016-fhir-r4b-and-r5.md)

## Context

[0016](0016-fhir-r4b-and-r5.md) stored resources written to an R5 server as sent. Clients porting from R4 then left R4 shapes in an R5 server, such as an Encounter with `period` and a single `class`, which other R5 clients cannot read and the HL7 FHIR Validator rejects.

## Decision

- The R4 to R5 converters change only elements still in their R4 form, so R5 input passes through unchanged.
- On an R5 server, every create and update runs through them before it reaches the store, in REST requests and in Bundles.
- R4 elements that R5 removed without a one to one replacement are rejected with `400` and an OperationOutcome that names the R5 replacement: `Device.patient` (DeviceAssociation), `Device.distinctIdentifier` (biologicalSourceEvent), `Encounter.statusHistory` and `Encounter.classHistory` (EncounterHistory), and a CareTeam participant with more than one role.
- Generated records keep their own R5 handling: devices get a DeviceAssociation, and the pulse oximetry flow rate component, whose unit R5's vital signs binding does not allow, is left out of generated data only. Writes never drop elements.
- Elements outside the converters are still stored as sent. This is not a general R4 to R5 converter or a validator.

## Consequences

- Clients can send the common R4 shapes to an R5 server and read back R5.
- The converters must stay idempotent as they grow.
