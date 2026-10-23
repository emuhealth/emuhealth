# 0016: FHIR R4B and R5

- Status: Accepted
- Date: 2026-10-23
- Refines: [0003](0003-fhir-r4-baseline.md), [0008](0008-fhir-core-design.md)

## Context

[0003](0003-fhir-r4-baseline.md) made FHIR R4 the baseline and deferred R4B and R5. Some apps target R5 (subscriptions, new resource types), and Google Cloud Healthcare FHIR stores can be R5. A full multi-version server would need a converter between versions for every resource and per-version profiles, which is far more than an emulator for development needs.

## Decision

- A fhir-core server serves one FHIR version: 4.0.1 (the default), 4.3.0, or 5.0.0. The `fhir` service takes `fhir.fhirVersion` (also `R4`, `R4B`, `R5`, or `major.minor`). `registerFhirRoutes` and `createFhirInstance` take a `fhirVersion` option. The version is kept per store outside the store data, so it survives reset.
- The version decides:
  - the known resource types, taken from each version's resource-types code system;
  - the CapabilityStatement `fhirVersion`;
  - `$versions`;
  - the `fhirVersion` parameter on response media types for R4B and R5. R4 keeps the plain media type it has always sent.
- Requests that ask only for another version through `Accept` get `406`, and bodies labeled with another version get `415`. Requests without a `fhirVersion` parameter are served as before.
- The synthetic generator still builds R4 records. For R5 they pass through a small converter that covers only the elements the generator uses (Encounter, MedicationRequest, Procedure, DocumentReference, Endpoint, and Device with a DeviceAssociation). R4B uses the R4 shapes, which those resources share.
- Search parameter definitions list both the R4 and the R5 element paths where R5 renamed an element, so one set of definitions serves every version.
- Resources written by clients are stored as sent. There is no conversion between versions and no validation against version profiles.
- The Inferno gate ([0013](0013-inferno-acceptance-gate.md)) keeps running against R4. Vendor layers stay on R4.

## Consequences

- R5 and R4B clients can develop against the emulator with version-correct metadata and generated data, at the cost of one converter that must grow with the generator.
- One server cannot serve two versions at once. Run a second service, or another fhir-core instance, for another version.
