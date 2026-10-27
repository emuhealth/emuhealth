# 0019: Scenario packs

- Status: Accepted
- Date: 2026-10-24
- Refines: [0018](0018-shared-synthetic-population.md)

## Context

The generated population covers common chronic conditions, but tests often need a specific clinical story: a patient whose diabetes is getting worse, an inpatient stay with a discharge summary, or a trial subject with a serious adverse event. Writing those by hand for each service repeats the work and breaks the shared identity of [0018](0018-shared-synthetic-population.md).

## Decision

- Scenario packs are part of fhir-core's generator: `generate.scenarios` (or `population.scenarios`) lists packs by name, or as `{ name, patient }` to pick the patient. Each pack has a default patient.
- The first packs are `diabetes-cgm`, `inpatient-stay`, and `trial-adverse-event`.
- A pack adds records with fixed ids and dates relative to the reference date, after the generated ones, and never draws from the random streams, so every other record stays the same.
- Services that use the population show the same story:
  - device users with the `diabetes-cgm` monitor get a diabetic glucose curve;
  - the HL7 v2 registry lists inpatient Encounters as discharged visits;
  - the linked Rave subject logs the serious adverse event.
- New codes a pack needs join the terminology fixtures. R5 conversion covers the resource types packs add.

## Consequences

- One config line sets up a cross-system story for tests and demos.
- Packs must keep fixed ids and leave the random streams alone, or existing seeds would change.
