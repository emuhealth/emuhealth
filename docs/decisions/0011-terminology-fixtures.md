# 0011: Terminology fixtures

- Status: Accepted
- Date: 2026-10-23
- Refines: [0004](0004-synthetic-data-only.md), [0009](0009-synthetic-patient-generator.md)

## Context

[0004](0004-synthetic-data-only.md) limits bundled terminology to license-free code systems, with LOINC and SNOMED CT only in small permitted subsets. Apps under development need to look up and validate the codes they see, and the synthetic generator ([0009](0009-synthetic-patient-generator.md)) already uses a fixed set of ICD-10-CM, RxNorm, CVX, LOINC, and UCUM codes.

## Decision

- The fixtures are exactly the codes the generator uses, exported from one table in `generator.ts` (`generatorTerminology`) and loaded as five CodeSystem resources with `content: fragment`. A test fails if the generator emits a code the fixtures do not contain. RxNorm codes were checked against NLM RxNav. SNOMED CT is not included.
- The `fhir` service loads them by default; `fhir.terminology: false` leaves them out. `fhir.generate: false` now means "no generated patients" rather than an empty server; an empty server is `generate: false` plus `terminology: false`. This refines the wording in [0009](0009-synthetic-patient-generator.md).
- `CodeSystem/$lookup` and `CodeSystem/$validate-code` work on any CodeSystem in the store, so users can load their own code sets.
- Attribution stays in `THIRD_PARTY_NOTICES.md`.

## Consequences

- Validation answers "not in this fragment" for real codes outside the subset; the message says so.
- Adding codes means adding them to the generator table first, which keeps the two in sync.
