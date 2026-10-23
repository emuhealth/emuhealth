# 0009: Synthetic patient generator

- Status: Accepted
- Date: 2026-10-23
- Refines: [0004](0004-synthetic-data-only.md)

## Context

[0004](0004-synthetic-data-only.md) says default seeds come from a built-in synthetic generator. Since 0.3.0 the `fhir` service starts empty unless a config lists resources, so a first `npx emuhealth --service fhir` has nothing to read or search, and the upcoming SMART patient picker has no patients to show.

## Decision

- `@emuhealth/fhir-core` includes a deterministic, Synthea-style generator (`generateSyntheticRecords`). Output depends only on its options (`patients`, `seed`, `referenceDate`), uses a fixed PRNG, and has readable ids such as `syn-patient-001`.
- The `fhir` service starts with 5 generated patients by default. `fhir.generate` replaces them with a configured population, and `fhir.generate: false` starts empty. `fhir.resources` is loaded on top in both cases. Resetting restores the configured state.
- Each patient gets US Core shaped Encounters, vital sign Observations, Conditions with matching MedicationRequests and labs, an occasional AllergyIntolerance, and Immunizations. One Organization and two Practitioners are shared.
- Generated data must look synthetic: every resource carries the `urn:emuhealth:tag|synthetic` meta tag, identifiers use `urn:emuhealth:synthetic:*` systems, phone numbers use the fictional 555-01xx range, names are common first and last names combined at random, and no SSNs, NPIs, or real addresses are generated.
- Codes come from ICD-10-CM, RxNorm, and CVX, plus a small set of LOINC codes for vitals and labs, with attribution in `THIRD_PARTY_NOTICES.md`. SNOMED CT is not used.

## Consequences

- Tests that need an empty server set `generate: false`, or use `registerFhirRoutes` directly.
- Configs written for 0.3.0 that only list `fhir.resources` now also get the 5 default patients unless they add `generate: false`.
- Changing the generator changes generated data for a given seed; such changes are noted in the changelog.
