# 0013: Inferno acceptance gate

- Status: Accepted
- Date: 2026-10-23
- Refines: [0009](0009-synthetic-patient-generator.md), [0011](0011-terminology-fixtures.md)

## Context

Phase 1 ends with an acceptance gate: the relevant ONC Inferno tests for US Core and SMART App Launch must pass against `@emuhealth/fhir-core`. Inferno needs Docker, Ruby, a Java validator, and several GB of memory, which is more than a developer laptop should spend on every change. Many US Core tests also skip unless the server holds data for each profile, and several US Core bindings use SNOMED CT or CPT, which emuhealth does not bundle ([0011](0011-terminology-fixtures.md)).

## Decision

- A GitHub Actions workflow (`.github/workflows/inferno.yml`) runs on `main` and on pull requests that touch `fhir-core`, the CLI, or the gate itself. It is not run locally.
  - **US Core job:** runs the US Core 3.1.1 FHIR API group from the pinned `us-core-test-kit` against the five default patients, with a token from the authorization code flow.
  - **SMART App Launch job:** runs the SMART App Launch STU2 standalone launch, EHR launch, and backend services groups through `inferno execute_script`. `tests/inferno/browser.mjs` plays the browser and answers the emuhealth pickers.
- `tests/inferno/check-results.mjs` fails the job when any required test fails or errors. Skips are reported.
- `tests/inferno/exceptions.json` lists the tests that cannot pass for an emulator, each with a reason. The only entry covers the TLS tests, because emuhealth serves plain HTTP on localhost.
- The generator covers every US Core 3.1.1 profile so the tests have data, and draws the new content from a second random stream, so values in the earlier records of the first three patients stay the same for a seed. Some choices refine [0009](0009-synthetic-patient-generator.md):
  - Every fifth patient, starting with the fourth, is a two-year-old.
  - NPIs have a valid check digit but start with 0, which no real NPI does.
  - ICD-10-PCS and the CDC Race and Ethnicity code set join the fixtures; both are public domain.
  - Concepts that would need SNOMED CT, CPT, or the NUCC taxonomy carry text, with the data absent reason `unknown` code where US Core expects a coding.

## Consequences

- Changes to `fhir-core` that break US Core or SMART behavior fail CI, even though the gate runs only in CI.
- The gate pins a test kit version. Moving to a newer kit, or to US Core 6.1.0 and later, is a separate change.
- Generated populations changed for patients from `syn-patient-004` on, and every patient gained resources.
