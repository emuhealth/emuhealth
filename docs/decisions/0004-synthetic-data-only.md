# 0004: Synthetic data only, no PHI

- Status: Accepted
- Date: 2026-10-22

## Context

Emulators store data in memory or local persistence with no access controls, audit trail, or encryption suitable for protected health information. Using them with real patient data would create HIPAA and GDPR exposure for users.

Clinical terminologies also carry licenses: LOINC and SNOMED CT have terms that limit redistribution.

## Decision

- emuhealth is for synthetic data only. Seeds, fixtures, examples, and tests must never contain real patient data.
- README, docs site, and the CLI start banner state this clearly.
- Default seeds come from a built-in synthetic generator (Synthea-style).
- Bundled terminology is limited to license-free code systems (RxNorm subset, ICD-10-CM, CVX, UCUM). LOINC and SNOMED CT content is included only in small subsets permitted by their licenses, with attribution in `THIRD_PARTY_NOTICES.md`.

## Consequences

- Contributors must review fixtures for real-looking identifiers (MRNs, SSNs, NPIs of real people) before merging.
- Some realistic terminology scenarios need users to load their own licensed code sets.
