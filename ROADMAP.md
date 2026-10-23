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

- [x] Rename the CLI package and folder to `emuhealth` (binary `emuhealth`, version `0.1.0`), keep `@emulators/*` upstream packages as they are ([ADR 0002](docs/decisions/0002-naming-and-publishing.md), [ADR 0005](docs/decisions/0005-cli-package-layout.md)) ([#9](https://github.com/emuhealth/emuhealth/pull/9))
- [x] Point the release workflow (`.github/workflows/release.yml`) at `emuhealth` and `@emuhealth/*` only ([#9](https://github.com/emuhealth/emuhealth/pull/9))
- [x] Update `repository`, `homepage`, and `bugs` fields in every `package.json` we publish ([#9](https://github.com/emuhealth/emuhealth/pull/9))
- [x] Document the upstream sync procedure in [`docs/upstream-sync.md`](docs/upstream-sync.md) ([#9](https://github.com/emuhealth/emuhealth/pull/9))
- [x] Confirm ownership of the `@emuhealth` npm scope ([#10](https://github.com/emuhealth/emuhealth/pull/10))
- [x] Add a `NOTICE` file stating this is a modified fork of vercel-labs/emulate (Apache-2.0 section 4) ([#10](https://github.com/emuhealth/emuhealth/pull/10))
- [x] Synthetic data warning in README, docs, agent skill, CLI help, and CLI start banners ([ADR 0004](docs/decisions/0004-synthetic-data-only.md)) ([#10](https://github.com/emuhealth/emuhealth/pull/10))

### First release

The unscoped `emuhealth` name is only reserved once it is published, so this comes before the remaining hygiene items.

- [x] Make the repository public and apply upstream's protections: rulesets, signed commits, `Release` environment ([ADR 0006](docs/decisions/0006-repository-protections.md)) ([#11](https://github.com/emuhealth/emuhealth/pull/11))
- [x] Publish `emuhealth@0.1.0` manually from a maintainer account, and create the [`v0.1.0` GitHub release](https://github.com/emuhealth/emuhealth/releases/tag/v0.1.0)
- [x] Configure npm trusted publishing for `emuhealth` (repository `emuhealth/emuhealth`, workflow `release.yml`, environment `Release`, token publishing disallowed) and add the package to the `emuhealth` npm org
- [x] Publish `0.1.1` from CI to validate trusted publishing (npm deadline: 2026-10-24 20:24 UTC) ([#14](https://github.com/emuhealth/emuhealth/pull/14))
- [x] Restore the release workflow's push trigger on `main` ([#13](https://github.com/emuhealth/emuhealth/pull/13))

### Remaining hygiene

- [x] Stable port range for health services starting at 4100, independent of upstream service order ([ADR 0001](docs/decisions/0001-soft-fork-strategy.md)) ([#15](https://github.com/emuhealth/emuhealth/pull/15))
- [x] Health service registry in its own file (`packages/emuhealth/src/registry-health.ts`), merged into `SERVICE_REGISTRY` with a minimal change ([#15](https://github.com/emuhealth/emuhealth/pull/15))
- [x] Branded config and environment names (`emuhealth.config.*`, `EMUHEALTH_PORT`) with fallback to the `emulate` names ([ADR 0007](docs/decisions/0007-branded-config-and-env-names.md)) ([#16](https://github.com/emuhealth/emuhealth/pull/16))
- [x] Rebrand `apps/web` (titles, npm links, prose), the `emuBar()` and footer in `core/src/ui.ts`, CLI `--help` docs links, and the `skills/emulate` skill name ([#17](https://github.com/emuhealth/emuhealth/pull/17))

## Phase 1: Shared health core

Goal: a reusable FHIR and SMART foundation that every EHR and cloud emulator builds on ([ADR 0003](docs/decisions/0003-fhir-r4-baseline.md)).

Package: `@emuhealth/fhir-core`

- [x] FHIR R4 resource store: create, read, update, patch, delete, `_history`, versioning, `ETag` and `If-Match` ([ADR 0008](docs/decisions/0008-fhir-core-design.md)) ([#19](https://github.com/emuhealth/emuhealth/pull/19))
- [x] Search: `_id`, `_lastUpdated`, `_count`, `_sort`, `_include`, `_revinclude`, common token, reference, date, and string parameters, chained search ([#20](https://github.com/emuhealth/emuhealth/pull/20), [#21](https://github.com/emuhealth/emuhealth/pull/21))
- [x] `batch` and `transaction` Bundles ([#22](https://github.com/emuhealth/emuhealth/pull/22))
- [x] `OperationOutcome` errors and `CapabilityStatement` at `/metadata` ([#24](https://github.com/emuhealth/emuhealth/pull/24))
- [x] `Patient/$everything` ([#27](https://github.com/emuhealth/emuhealth/pull/27))
- [x] Bulk Data `$export` with NDJSON output ([#33](https://github.com/emuhealth/emuhealth/pull/33))
- [x] SMART App Launch: EHR and standalone launch, PKCE, v1 and v2 scopes, `.well-known/smart-configuration`, patient and practitioner picker built on `renderUserButton` ([ADR 0010](docs/decisions/0010-smart-app-launch.md)) ([#29](https://github.com/emuhealth/emuhealth/pull/29), [#30](https://github.com/emuhealth/emuhealth/pull/30))
- [x] SMART Backend Services: `client_credentials` with JWT client assertion ([#32](https://github.com/emuhealth/emuhealth/pull/32))
- [x] Synthetic patient generator seeded from config (Patient, Encounter, Observation, Condition, MedicationRequest, AllergyIntolerance, Immunization) ([ADR 0009](docs/decisions/0009-synthetic-patient-generator.md)) ([#26](https://github.com/emuhealth/emuhealth/pull/26))
- [x] License-free terminology fixtures (RxNorm subset, ICD-10-CM, CVX, UCUM); LOINC and SNOMED only within their license terms ([ADR 0011](docs/decisions/0011-terminology-fixtures.md))
- [x] FHIR inspector page added to `core/src/ui.ts` ([#34](https://github.com/emuhealth/emuhealth/pull/34))
- [x] Acceptance gate: relevant ONC Inferno tests (US Core, SMART App Launch) pass ([ADR 0013](docs/decisions/0013-inferno-acceptance-gate.md)) ([#38](https://github.com/emuhealth/emuhealth/pull/38))

## Phase 2: EHR and clinical vendors

Each is a thin layer over `fhir-core` adding the vendor's URL shape, auth quirks, error formats, and proprietary endpoints.

- [x] Epic (FHIR R4, SMART, backend JWT auth, scheduling) ([ADR 0014](docs/decisions/0014-vendor-layers-over-fhir-core.md)) ([#39](https://github.com/emuhealth/emuhealth/pull/39))
- [x] Oracle Health / Cerner (tenant URL shape, SMART) ([#48](https://github.com/emuhealth/emuhealth/pull/48))
- [x] athenahealth (proprietary REST plus FHIR) ([#49](https://github.com/emuhealth/emuhealth/pull/49))
- [x] CMS Blue Button 2.0 (patient access OAuth, ExplanationOfBenefit, Coverage) ([#50](https://github.com/emuhealth/emuhealth/pull/50))
- [x] CDS Hooks (discovery, simulated EHR firing `patient-view` and `order-sign`) ([#51](https://github.com/emuhealth/emuhealth/pull/51))
- [x] Redox (JSON data models, signed webhooks via `core/src/webhooks.ts`) ([#52](https://github.com/emuhealth/emuhealth/pull/52))

## Phase 3: Cloud health data platforms

- [x] AWS HealthLake (alongside `@emulators/aws`, SigV4) ([#53](https://github.com/emuhealth/emuhealth/pull/53))
- [x] Google Cloud Healthcare API (FHIR stores first) ([#54](https://github.com/emuhealth/emuhealth/pull/54))
- [x] Azure Health Data Services (Entra auth via the Microsoft emulator) ([#55](https://github.com/emuhealth/emuhealth/pull/55))

## Phase 4: Revenue cycle and payer

- [x] Stedi (eligibility 270/271, claims 837, claim status 276/277, ERA 835) ([#56](https://github.com/emuhealth/emuhealth/pull/56))
- [x] Availity (feasibility check first, public docs are limited) ([#57](https://github.com/emuhealth/emuhealth/pull/57))

## Phase 5: Life sciences

Public reference APIs are read-heavy and quick to build, so they can be pulled forward as early wins.

- [x] openFDA (drug labels, adverse events, recalls) ([#40](https://github.com/emuhealth/emuhealth/pull/40))
- [x] NLM RxNav / RxNorm ([#41](https://github.com/emuhealth/emuhealth/pull/41))
- [x] ClinicalTrials.gov API v2 ([#42](https://github.com/emuhealth/emuhealth/pull/42))
- [x] NCBI E-utilities (PubMed, Gene) ([#43](https://github.com/emuhealth/emuhealth/pull/43))
- [x] NPPES NPI Registry ([#44](https://github.com/emuhealth/emuhealth/pull/44))
- [x] Benchling (entries, sequences, registry, results, webhooks) ([#45](https://github.com/emuhealth/emuhealth/pull/45))
- [x] REDCap (records, metadata, export and import) ([#46](https://github.com/emuhealth/emuhealth/pull/46))

## Phase 6: Devices and wearables

- [x] Dexcom (CGM, OAuth) ([#58](https://github.com/emuhealth/emuhealth/pull/58))
- [x] Fitbit ([#59](https://github.com/emuhealth/emuhealth/pull/59))
- [x] Oura ([#60](https://github.com/emuhealth/emuhealth/pull/60))
- [x] Withings ([#61](https://github.com/emuhealth/emuhealth/pull/61))
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
