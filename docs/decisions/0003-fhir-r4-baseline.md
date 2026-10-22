# 0003: FHIR R4 and SMART as the baseline

- Status: Accepted
- Date: 2026-10-22

## Context

Most health APIs we want to emulate (Epic, Oracle Health, athenahealth FHIR, Blue Button, AWS HealthLake, Google Cloud Healthcare, Azure Health Data Services) expose FHIR. US regulation (ONC certification, CMS interoperability rules) centers on FHIR R4, US Core, and SMART App Launch. R4B and R5 exist but vendor adoption is limited.

## Decision

- Build one shared package, `@emuhealth/fhir-core`, before any vendor emulator.
- Target FHIR R4 (4.0.1) with US Core profiles and SMART App Launch (v1 and v2 scopes) plus SMART Backend Services.
- Vendor emulators are thin layers over `fhir-core` that add URL shapes, auth quirks, error formats, and proprietary endpoints.
- Fidelity is checked with ONC Inferno test kits (US Core, SMART App Launch) as an acceptance gate.
- R4B and R5 are deferred to the "Later" section of the roadmap.

## Consequences

- Phase 1 is a larger upfront investment, but each vendor emulator afterwards is small.
- Apps targeting R5-only features are not served initially.
