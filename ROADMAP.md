# emuhealth Roadmap

emuhealth is a soft fork of [vercel-labs/emulate](https://github.com/vercel-labs/emulate) focused on healthcare and life science APIs. It keeps every upstream emulator and adds stateful, production-fidelity emulators for EHRs, health data platforms, payers, life science tools, and devices. Synthetic data only, never real PHI.

How we work:

- Work proceeds one item at a time, each in its own branch and PR.
- When an item ships, tick its box here and link the PR.
- Decisions that shape the whole project are recorded in [`docs/decisions/`](docs/decisions/). Change a decision by adding a new record, not by rewriting an old one.
- Every item follows [AGENTS.md](AGENTS.md), including the docs update rule (README, skills, docs site, CLI help).

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done.

## Phase 0: Fork hygiene

Goal: the fork builds, publishes, and identifies itself as emuhealth without diverging from upstream more than needed.

- [ ] Rename the CLI package to `emuhealth` (binary `emuhealth`), keep `@emulators/*` upstream packages as they are ([ADR 0002](docs/decisions/0002-naming-and-publishing.md))
- [ ] Confirm ownership of the `@emuhealth` npm scope and publish rights
- [ ] Point the release workflow (`.github/workflows/release.yml`) at our package names and repo
- [ ] Update `repository`, `homepage`, and `bugs` fields in every `package.json` we publish
- [ ] Add a `NOTICE` file stating this is a modified fork of vercel-labs/emulate (Apache-2.0 section 4)
- [ ] Rebrand README header and badges, `apps/web`, the `emuBar()` and footer in `core/src/ui.ts`, and CLI `--help`
- [ ] Stable port range for health services starting at 4100, independent of upstream service order ([ADR 0001](docs/decisions/0001-soft-fork-strategy.md))
- [ ] Health service registry in its own file (`packages/emulate/src/registry-health.ts`), merged into `SERVICE_REGISTRY` with a minimal change
- [ ] Synthetic data warning in README, docs, and the CLI start banner ([ADR 0004](docs/decisions/0004-synthetic-data-only.md))
- [ ] Document the upstream sync procedure in `docs/upstream-sync.md`

## Phase 1: Shared health core

Goal: a reusable FHIR and SMART foundation that every EHR and cloud emulator builds on ([ADR 0003](docs/decisions/0003-fhir-r4-baseline.md)).

Package: `@emuhealth/fhir-core`

- [ ] FHIR R4 resource store: create, read, update, patch, delete, `_history`, versioning, `ETag` and `If-Match`
- [ ] Search: `_id`, `_lastUpdated`, `_count`, `_sort`, `_include`, `_revinclude`, common token, reference, date, and string parameters, chained search
- [ ] `batch` and `transaction` Bundles
- [ ] `OperationOutcome` errors and `CapabilityStatement` at `/metadata`
- [ ] `Patient/$everything`
- [ ] Bulk Data `$export` with NDJSON output
- [ ] SMART App Launch: EHR and standalone launch, PKCE, v1 and v2 scopes, `.well-known/smart-configuration`, patient and practitioner picker built on `renderUserButton`
- [ ] SMART Backend Services: `client_credentials` with JWT client assertion
- [ ] Synthetic patient generator seeded from config (Patient, Encounter, Observation, Condition, MedicationRequest, AllergyIntolerance, Immunization)
- [ ] License-free terminology fixtures (RxNorm subset, ICD-10-CM, CVX, UCUM); LOINC and SNOMED only within their license terms
- [ ] FHIR inspector page added to `core/src/ui.ts`
- [ ] Acceptance gate: relevant ONC Inferno tests (US Core, SMART App Launch) pass

## Phase 2: EHR and clinical vendors

Each is a thin layer over `fhir-core` adding the vendor's URL shape, auth quirks, error formats, and proprietary endpoints.

- [ ] Epic (FHIR R4, SMART, backend JWT auth, scheduling)
- [ ] Oracle Health / Cerner (tenant URL shape, SMART)
- [ ] athenahealth (proprietary REST plus FHIR)
- [ ] CMS Blue Button 2.0 (patient access OAuth, ExplanationOfBenefit, Coverage)
- [ ] CDS Hooks (discovery, simulated EHR firing `patient-view` and `order-sign`)
- [ ] Redox (JSON data models, signed webhooks via `core/src/webhooks.ts`)

## Phase 3: Cloud health data platforms

- [ ] AWS HealthLake (alongside `@emulators/aws`, SigV4)
- [ ] Google Cloud Healthcare API (FHIR stores first)
- [ ] Azure Health Data Services (Entra auth via the Microsoft emulator)

## Phase 4: Revenue cycle and payer

- [ ] Stedi (eligibility 270/271, claims 837, claim status 276/277, ERA 835)
- [ ] Availity (feasibility check first, public docs are limited)

## Phase 5: Life sciences

Public reference APIs are read-heavy and quick to build, so they can be pulled forward as early wins.

- [ ] openFDA (drug labels, adverse events, recalls)
- [ ] NLM RxNav / RxNorm
- [ ] ClinicalTrials.gov API v2
- [ ] NCBI E-utilities (PubMed, Gene)
- [ ] NPPES NPI Registry
- [ ] Benchling (entries, sequences, registry, results, webhooks)
- [ ] REDCap (records, metadata, export and import)

## Phase 6: Devices and wearables

- [ ] Dexcom (CGM, OAuth)
- [ ] Fitbit
- [ ] Oura
- [ ] Withings
- [ ] Terra (aggregator)

Apple HealthKit and Android Health Connect are on-device APIs and out of scope.

## Later

- [ ] DICOMweb (QIDO-RS, WADO-RS, STOW-RS)
- [ ] HL7v2 over MLLP (needs a TCP listener in core)
- [ ] Veeva Vault, Medidata Rave (APIs partly gated, check access first)
- [ ] FHIR R4B and R5 support

## Suggested order

1. Phase 0
2. `fhir-core` with SMART and synthetic seeding
3. Epic
4. openFDA and RxNav (shows the life science side early)
5. Remaining phases in order, adjusted by user demand

## Definition of done for every emulator

- Lives in `packages/@emuhealth/<name>` and is registered in `registry-health.ts`
- UI uses only the shared render functions in `core/src/ui.ts`
- Contract tests in `tests/contracts`
- Seed config documented with an example in `emulate.config.example.yaml`
- Docs updated: `README.md`, `skills/<name>/SKILL.md`, `apps/web` docs page, CLI `--help`
- An example app in `examples/` where it helps (SMART launch, CDS Hooks service, and so on)
- Uses synthetic data only
