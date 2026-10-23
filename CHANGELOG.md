# Changelog

<!-- release:start -->
## 0.7.0

Fifteen new emulators finish the EHR, cloud, payer, and wearable phases of the roadmap: Oracle Health, athenahealth, CMS Blue Button 2.0, CDS Hooks, Redox, AWS HealthLake, Google Cloud Healthcare, Azure Health Data Services, Stedi, Availity, Dexcom, Fitbit, Oura, Withings, and Terra. Synthetic data only.

### New Features

- **Oracle Health (Cerner)** (`--service cerner`, port 4109): FHIR R4 under the Millennium tenant path, provider and patient persona OAuth, system accounts with client secrets, and Millennium's required search parameters (#48)
- **athenahealth** (`--service athena`, port 4110): the proprietary `/v1/{practiceid}` API for patients, chart data, and appointments, and FHIR R4 with `ah-practice`, behind client credentials (#49)
- **CMS Blue Button 2.0** (`--service bluebutton`, port 4111): beneficiary OAuth and read-only Patient, Coverage, and ExplanationOfBenefit for synthetic Medicare beneficiaries (#50)
- **CDS Hooks** (`--service cdshooks`, port 4112): a simulated EHR that fires `patient-view` and `order-sign` at your CDS service with signed JWTs and prefetch and checks the cards, plus sample services (#51)
- **Redox** (`--service redox`, port 4113): Redox JSON data models at `/endpoint` and EHR events to your destinations with verification tokens (#52)
- **AWS HealthLake** (`--service healthlake`, port 4114): the control plane and per-datastore FHIR R4 with real SigV4 verification (#53)
- **Google Cloud Healthcare API** (`--service gcphealthcare`, port 4115): datasets, FHIR stores, and FHIR R4 per store (#54)
- **Azure Health Data Services** (`--service azurehealth`, port 4116): FHIR services per workspace with Entra ID token verification against the Microsoft emulator (#55)
- **Stedi** (`--service stedi`, port 4117): eligibility (270/271), professional claims (837P), claim status (276/277), and 835 ERAs (#56)
- **Availity** (`--service availity`, port 4118): asynchronous coverages and claim statuses, service reviews (278), and Demo plan mock scenarios (#57)
- **Dexcom** (`--service dexcom`, port 4119): OAuth and API v3 glucose (EGVs), events, devices, and data range (#58)
- **Fitbit** (`--service fitbit`, port 4120): OAuth and profile, activity, heart rate with intraday data, sleep stages, and weight (#59)
- **Oura** (`--service oura`, port 4121): OAuth and API v2 daily sleep, activity, readiness, SpO2, sleep periods, and heart rate (#60)
- **Withings** (`--service withings`, port 4122): OAuth, measures, activity, sleep, devices, and notify callbacks (#61)
- **Terra** (`--service terra`, port 4123): widget connections, normalized daily, sleep, activity, and body data, and signed webhooks (#62)

### Changes

- fhir-core: `clientCredentialsWithSecret`, `patientAccess`, `issueSmartToken`, and `createFhirInstance` for vendor and cloud emulators; ExplanationOfBenefit search parameters; picker paths work with authorize paths that end in a slash (#48, #49, #50, #53)
- The Microsoft emulator issues signed JWT access tokens for non-Graph resources (`<resource>/.default`), as Entra ID does; Graph tokens are unchanged (#55)
- The shared UI gains an `inspector-field` style for form fields (#51)
- A private `@emuhealth/device-core` package holds the synthetic sensor data and OAuth flow the wearable emulators share (#58)

### Documentation

- Docs pages and agent skills for every new emulator

<!-- release:end -->

## 0.6.0

The FHIR server now passes the ONC Inferno US Core and SMART App Launch tests in CI, and eight new emulators cover Epic and the life science APIs: openFDA, RxNav, ClinicalTrials.gov, NCBI E-utilities, the NPPES NPI Registry, Benchling, and REDCap. Synthetic data only.

### New Features

- **Inferno acceptance gate**: every change to the FHIR server runs the US Core 3.1.1 FHIR API tests (272 pass) and the SMART App Launch STU2 standalone, EHR, and backend services tests in CI. Only the TLS checks are expected to fail on a local HTTP emulator (#38)
- **US Core synthetic data**: generated patients now cover every US Core 3.1.1 profile, including race and ethnicity, Provenance, notes, procedures, goals, care plans, care teams, devices, and a pediatric patient (#38)
- **Epic** (`--service epic`, port 4101): the FHIR server under `/api/FHIR/R4` with OAuth 2.0 at `/oauth2`, `__epic.dstu2.patient` in token responses, Epic's informational OperationOutcome on empty searches, and `Appointment/$find` and `$book` scheduling (#39)
- **openFDA** (`--service openfda`, port 4102): drug labels, adverse events, and drug, device, and food recalls with the openFDA query language, `count`, `sort`, and paging (#40)
- **RxNav** (`--service rxnav`, port 4103): the RxNorm REST API (`rxcui`, `drugs`, `properties`, `related`, `allrelated`, `approximateTerm`, `spellingsuggestions`) over a verified RxNorm subset (#41)
- **ClinicalTrials.gov** (`--service clinicaltrials`, port 4104): API v2 study search with queries, filters, `AREA[]` clauses, `fields`, `sort`, and page tokens over synthetic `NCT99` studies (#42)
- **NCBI E-utilities** (`--service ncbi`, port 4105): `esearch` with history, `esummary`, `efetch`, `elink`, and `einfo` for synthetic PubMed articles and ten real human genes (#43)
- **NPPES NPI Registry** (`--service nppes`, port 4106): provider search by NPI, name, taxonomy, and place over synthetic providers whose NPIs can never be real (#44)
- **Benchling** (`--service benchling`, port 4107): API v2 sequences, notebook entries, registration, assay results, events, and Svix-signed webhooks (#45)
- **REDCap** (`--service redcap`, port 4108): the `/api/` endpoint for metadata and record export, import, and delete in JSON, CSV, or XML (#46)

### Changes

- The FHIR server serves `/.well-known/openid-configuration`, and a SMART token can always read its own `fhirUser` resource (#38)
- fhir-core gains `smart.tokenExtras` and `searchBundle` hooks for vendor emulators (#39)
- Generated populations changed: patients from `syn-patient-004` on differ, and every patient has more resources (#38)

### Documentation

- [ADR 0013](https://github.com/emuhealth/emuhealth/blob/main/docs/decisions/0013-inferno-acceptance-gate.md) on the Inferno gate and [ADR 0014](https://github.com/emuhealth/emuhealth/blob/main/docs/decisions/0014-vendor-layers-over-fhir-core.md) on vendor layers over fhir-core (#38, #39)
- Docs pages and agent skills for every new emulator

## 0.5.0

Server-to-server access and bulk export, a browsable inspector, and terminology for the FHIR server. Synthetic data only.

### New Features

- **SMART Backend Services**: clients registered with `jwks` or `jwks_uri` authenticate with a signed JWT client assertion (`private_key_jwt`, RS384 or ES384) and use `client_credentials` for 5 minute tokens with `system/` scopes. Asymmetric clients can also use `private_key_jwt` for the authorization code flow (#32)
- **Bulk Data `$export`**: `/$export`, `/Patient/$export`, and `/Group/:id/$export` with `Prefer: respond-async` return a status URL and a manifest of NDJSON files, one per resource type, with `_type`, `_since`, and `_outputFormat`. Exports respect SMART scopes, and exports started with a token need the same client's token to download (#33)
- **FHIR inspector**: open `/_inspector` to browse resources by type with every version, recent changes, SMART clients and live tokens, and Bulk Data exports (#34)
- **Terminology fixtures**: small ICD-10-CM, RxNorm, CVX, LOINC, and UCUM CodeSystems with exactly the codes the generator uses, plus `CodeSystem/$lookup` and `CodeSystem/$validate-code`, which also work on CodeSystems you load (#35)

### Changes

- `fhir.generate: false` now means "no generated patients"; the terminology fixtures stay. For a completely empty server, also set `fhir.terminology: false` (#35)
- CodeSystem and ValueSet can be searched by `url`, `name`, `status`, and `version` (#35)

### Documentation

- Terminology fixtures in [ADR 0011](https://github.com/emuhealth/emuhealth/blob/main/docs/decisions/0011-terminology-fixtures.md) (#35)

## 0.4.0

The FHIR server now starts with synthetic patients and supports SMART App Launch, so SMART apps can launch, pick a patient, and get scoped tokens against `npx emuhealth --service fhir`. Synthetic data only.

### New Features

- **Synthetic patients**: the `fhir` service starts with 5 generated, deterministic synthetic patients, each with encounters, vital signs, conditions, medications, labs, allergies, and immunizations. `fhir.generate` sets `patients`, `seed`, and `referenceDate`, and `generate: false` starts empty. Records are tagged synthetic and use ICD-10-CM, RxNorm, CVX, and a small set of LOINC codes (#26)
- **`Patient/$everything`**: one Bundle with a patient, every resource that references it, and the practitioners and organizations those point to, with `_type`, `_since`, and `_count` paging. Also at the type level (#27)
- **SMART App Launch**: discovery at `/.well-known/smart-configuration`, authorization with patient and practitioner pickers, an EHR launch simulator at `/auth/launch`, and a token endpoint with S256 PKCE, refresh, introspection, revocation, and a signed `id_token` for `openid fhirUser`. Any client works until you register clients under `fhir.smart.clients` (#29)
- **SMART enforcement**: requests that present a token are held to its SMART v1 or v2 scopes (including granular `?category=` constraints) and, for `patient/` scopes, to that patient's records across reads, search, history, `$everything`, writes, and Bundles. Requests without a token keep full access unless `fhir.smart.required: true`. `/metadata` advertises SMART security (#30)

### Changes

- Configs that only list `fhir.resources` now also get the 5 generated patients. Add `fhir.generate: false` to keep the server empty apart from your resources (#26)
- A request that sends an unknown or expired `Authorization: Bearer` token now gets `401` from the FHIR API (#30)

### Documentation

- SMART App Launch design in [ADR 0010](https://github.com/emuhealth/emuhealth/blob/main/docs/decisions/0010-smart-app-launch.md) and the synthetic generator in [ADR 0009](https://github.com/emuhealth/emuhealth/blob/main/docs/decisions/0009-synthetic-patient-generator.md) (#26, #28)
- LOINC, RxNorm, ICD-10-CM, and CVX attribution in `THIRD_PARTY_NOTICES.md` (#26)

## 0.3.0

The first health emulator: a stateful FHIR R4 server. Run it with `npx emuhealth --service fhir` on `http://localhost:4100`. Synthetic data only, never real patient data.

### New Features

- **FHIR R4 server**: create, read, vread, update (including create on update), JSON Patch, and logical delete for every R4 resource type, with `meta.versionId`, `ETag`, `If-Match` (412 on conflict), `If-None-Match`, `Prefer: return=minimal`, and instance, type, and system `_history`. Errors are `OperationOutcome` resources. Seed synthetic resources under `fhir.resources` in the config (#19)
- **FHIR search**: `GET /:type` and `POST /:type/_search` with `_id`, `_lastUpdated`, and the common string, token, date, and reference parameters of the main US Core resources, modifiers (`:exact`, `:contains`, `:not`, `:text`, `:missing`, `:Type`), date prefixes, `_sort`, `_count` paging, `_summary=count`, and `Prefer: handling=strict` (#20)
- **Includes and chained search**: `_include`, `_revinclude`, `:iterate`, and chained parameters such as `patient.family` (#21)
- **Batch and transaction Bundles**: `POST /` with a Bundle. Transactions are all or nothing, rewrite `urn:uuid:` references to the new ids, and support conditional create with `ifNoneExist` (#22)
- **CapabilityStatement** at `/metadata`, generated from what the server supports, so FHIR clients that check it on connect work out of the box. Paths that are not FHIR interactions return an `OperationOutcome` 404 (#24)

### Documentation

- FHIR R4 page on the [docs site](https://www.emuhealth.dev/docs/fhir) and a `fhir` agent skill (#19)

### Testing

- Longer timeout for the cold-start `createEmulator` test, which was timing out on busy CI runners (#23)

## 0.2.0

### New Features

- **Health service registry**: groundwork for the upcoming health and life science emulators, which get their own registry and fixed default ports starting at 4100 (base port + 100). A health service will keep its port no matter which other services run, and `--port` moves the whole range with the base port (#15)
- **emuhealth config and environment names**: config discovery looks for `emuhealth.config.*` (TypeScript, JavaScript, YAML, or JSON) first, and `EMUHEALTH_PORT`, `EMUHEALTH_BASE_URL`, and `EMUHEALTH_DEBUG` take precedence. The `emulate.config.*`, `service-emulator.config.*`, and `EMULATE_*` names keep working as fallbacks. When both an `emuhealth.config.*` and an `emulate.config.*` file exist, the emuhealth one is used (#16)

### Improvements

- **`init` writes `emuhealth.config.yaml`** and refuses to run when any recognized config file already exists. `init --custom` creates `emuhealth.config.ts` when the project has no config (#16)
- **Emulator pages link to emuhealth**: the header links, "Powered by emuhealth" footer, and page titles in every emulator UI point to emuhealth (#17)
- **Docs at [www.emuhealth.dev](https://www.emuhealth.dev)**: CLI help and the README link to the new docs site (#17)
- **Agent skill renamed** from `emulate` to `emuhealth` (#17)

## 0.1.1

### Improvements

- **npm provenance**: emuhealth is now published from GitHub Actions through npm trusted publishing, so each release links to the exact commit and workflow that built it. Publishing requires maintainer approval and no longer uses tokens (#13)

## 0.1.0

First release of **emuhealth**, a fork of [emulate](https://github.com/vercel-labs/emulate) focused on healthcare and life science APIs. This release establishes the package, CLI, and release process. Health emulators follow in later releases (see [ROADMAP.md](https://github.com/emuhealth/emuhealth/blob/main/ROADMAP.md)).

### Changes from emulate

- **New package name**: the CLI and programmatic API are published as `emuhealth`. Run `npx emuhealth`, install with `npm install emuhealth`, and import from `emuhealth`. Project configs that import from `emulate` keep working (#9)
- **Synthetic data notice** in CLI help and start banners: emuhealth is for synthetic data only and must never hold real patient data (#10)
- **NOTICE file** identifying emuhealth as a modified version of emulate, shipped in the package (#10)

### Included from emulate

- All emulate 0.12.2 services: Vercel, GitHub, Google, Slack, Apple, Microsoft, Okta, AWS, Resend, Stripe, MongoDB Atlas, Clerk, Linear, and Twilio
- Upstream changes made after emulate 0.12.2, not yet released by emulate: AWS Cognito and SQS JSON requests, Slack interactivity, event retries, app mentions, app uninstall, Slack Connect fixtures, and channel privacy changes, Resend recipient rejection and cookie protection, GitHub check run pagination and App identity, Google OAuth credential validation, and Vercel Blob direct HTTP parity

Entries below are emulate's own history, which emuhealth includes.

## 0.12.2

### Improvements

- **Vercel Blob route organization** splits uploads, listings, deletes, content delivery, and shared helpers into focused modules while preserving existing behavior (#299)

### Testing

- Expanded **Vercel Blob coverage** for multipart uploads, browser tokens, private stores, content delivery, authentication, and legacy compatibility, with expected failures documenting unsupported behavior (#278)

### Contributors

- @scotttrinh

## 0.12.1

### Bug Fixes

- Fixed **emulator network exposure** by binding built-in and custom HTTP listeners to IPv4 loopback (`127.0.0.1`) by default. Container and remote workflows can opt into network access with `--host 0.0.0.0` or `hostname: '0.0.0.0'` (#276)

## 0.12.0

### New Features

- **Custom stateful HTTP APIs** let projects define typed emulators with seeds, reset, snapshots, and optional persistence, then reuse the same definitions in tests and Next.js or Nuxt adapters (#268)
- **Custom API development workflow** adds `npx emulate init --custom inventory`, TypeScript and JavaScript configuration, watch mode, and request, route, and state inspection alongside built-in services (#268)

### Improvements

- **Slack event signatures** use the configured `slack.signing_secret` to send Slack-compatible timestamp and signature headers (#266)
- **Slack event envelopes** include the installation team, unique event ID, and event timestamp for routing and deduplication (#267)

### Contributors

- @ctate
- @K-Mistele
- @Railly

## 0.11.2

### New Features

- **GitHub raw media negotiation** adds Accept-based binary responses for Contents and README endpoints (#237)
- **Google Calendar discovery** adds an unauthenticated Calendar v3 discovery document for local clients (#238)
- **GitHub organization membership seeding** adds `orgs[].members` configuration with member and admin roles (#240)
- **Resend idempotency keys** make email and batch sends replayable without duplicate records or webhooks (#239)

### Improvements

- **Slack message limits** enforce Slack's 40,000-character limit with safe truncation and warning metadata (#244)
- **Google OIDC verification** issues RS256-signed ID tokens and exposes the matching JWKS endpoint (#247)
- **Configuration examples and service docs** now reflect the current emulator registry and CLI options (#248)

### Bug Fixes

- Fixed **GitHub Checks** list endpoints for slash-containing branch and tag refs (#246)
- Fixed **GitHub App installation writes** to authenticate as the App bot for organization installations (#242)
- Fixed **AWS S3** uploads, copies, and downloads to preserve arbitrary binary payloads (#241, #245)
- Fixed **Microsoft refresh tokens** to remain bound to the OAuth client that issued them (#243)

## 0.11.1

### Improvements

- **Vercel v7 deployment listing** adds authenticated `GET /v7/deployments` with commit-SHA filtering across projects, team scoping, and pagination (#234)

## 0.11.0

### New Features

- **Persistent adapter runtime** shares state handling across the Next.js and Nuxt adapters, including atomic initialization and generated GitHub App key persistence across cold starts
- **Linear issue priority labels** expose the derived `priorityLabel` alongside numeric issue priority in queries and mutations
- **GitHub installation-token inspection** exposes secret-free metadata for minted App installation tokens, including permissions, repository access, expiry, and lifecycle status

### Contributors

- @ctate
- @Railly

## 0.10.0

### New Features

- **Expanded GitHub repository APIs** add stateful contents, README, commits, comparisons, raw file downloads, Git Data shapes, branch isolation, and commit-producing file writes (#191)
- **Generated GitHub App keys** let `createEmulator` generate RSA private keys for GitHub Apps that omit `private_key`, expose generated material through `generatedSecrets`, and preserve it across resets (#200)

### Bug Fixes

- Fixed **Stripe webhook signatures** to send Stripe-compatible `Stripe-Signature` headers over the raw request body (#198)
- Fixed **GitHub App JWT verification** for documented PKCS#1 keys and PKCS#8 keys by deriving public key material before verification (#199)

### Contributors

- @ctate
- @EfeDurmaz16
- @Railly
- @sidpalas

## 0.9.0

### New Features

- **Nuxt emulator adapter** — new `@emulators/adapter-nuxt` package for embedding emulators in Nuxt apps, with Nuxt server route handling, persistence, response rewriting, and Nitro tracing support (#188)
- **Nuxt embedded example** — added `examples/nuxt-embedded` demonstrating same-origin OAuth flows (GitHub + Google), a catch-all emulate server route, and cookie-based sessions (#188)

### Improvements

- **Nuxt docs and agent guidance** — documented Nuxt setup across the README, docs site, and agent skills (#188)

### Contributors

- @ctate

## 0.8.0

### New Features

- **Twilio emulator** — local Twilio API emulation with accounts, phone numbers, messages, calls, conversations, messaging services, Verify flows, simulator endpoints, SDK conformance tests, and inspector support (#185)
- **Twilio SMS verification example** — working Next.js example for SMS verification with the Twilio emulator and local session handling (#186)

### Improvements

- **Twilio docs and agent guidance** — added README, docs site, and skill coverage for local Twilio development (#185, #186)

### Contributors

- @ctate

## 0.7.0

### New Features

- **Linear emulator** — stateful Linear GraphQL API emulation with seeded organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, agent sessions, and local inspector support (#180)

### Improvements

- **Linear docs and agent guidance** — added README, docs site, programmatic API, and skill coverage for Linear API, OAuth, and webhook testing (#180)

### Contributors

- @ctate

## 0.6.1

### New Features

- **Vercel Blob emulator** — local emulation for Vercel Blob store operations, including uploads, downloads, listings, deletes, copy support, and inspector visibility (#175)

### Improvements

- **Vercel Blob examples** — added and hardened an example app that exercises upload sharing URL handling

### Contributors

- @ctate

## 0.6.0

### New Features

- **Expanded Slack emulator support** — stateful Slack writes for rich chat messages, updates, deletes, permalinks, ephemeral and scheduled messages, conversations and DMs, OAuth installs and scopes, user profiles and presence, modern file uploads, pins and bookmarks, App Home views, modals, inspector tabs, event delivery visibility, docs, and coverage matrix (#152-#164)

### Improvements

- **Slack SDK coverage** — added Slack WebClient conformance tests and route coverage for the supported Slack Web API surface (#152-#164)
- **Slack docs** — audited README, package docs, web docs, skill guidance, CLI seed output, strict scope notes, and unsupported Slack families against the implemented surface (#164)

### Contributors

- @ctate

## 0.5.0

### New Features

- **Clerk emulator** — local emulation of Clerk authentication and session management (#38)
- **Portless integration** — embed emulators directly in your app without dedicated ports, with base URL override support (#78)
- **Google `hd` claim** — hosted domain claim in ID tokens and userinfo for Google OAuth (#73)
- **Stripe Checkout example** — full working example of Stripe Checkout with the Stripe emulator (#82)
- **Resend magic link example** — working example of Resend magic link authentication flow (#51)
- **Docs landing page** — new landing page for the docs site (#81)

### Improvements

- **Unified UI design system** — all emulator UIs now share a consistent design system with CI quality checks (#50)
- **Stripe** — added customer sessions and payment methods API (#47)

### Bug Fixes

- Fixed **AWS S3** emulator compatibility with the official AWS SDK wire format (#65, #69)
- Fixed **Resend** email inbox links not being clickable in preview (#80)

### Contributors

- @ctate
- @disintegrator
- @jlucaso1
- @Railly
- @tmm

## 0.4.1

### Bug Fixes

- Include README in all `@emulators/*` npm packages

## 0.4.0

### New Features

- **Next.js adapter** — embed emulators directly in your Next.js app via `@emulators/adapter-next`, solving the Vercel preview deployment problem where OAuth callback URLs change with every deployment (#43)
- **MongoDB Atlas emulator** — local emulation of MongoDB Atlas with Data API support (#18)
- **Stripe emulator** — local emulation of Stripe billing and payment APIs (#4)
- **Resend emulator** — local emulation of the Resend email API (#7)
- **Okta emulator** — local emulation of Okta authentication and OIDC flows (#32)

### Improvements

- **Microsoft Entra ID** — added v1 OAuth token endpoint and Microsoft Graph `/users/{id}` route (#30)

### Bug Fixes

- Fixed multiple bugs, security hardening, and quality improvements across all emulators (#37)

### Contributors

- @AmorosoDavid12
- @ctate
- @jk4235
- @mvanhorn
