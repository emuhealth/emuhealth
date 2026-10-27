# Contributing to emuhealth

Thanks for helping make health API emulation better. This guide covers setting up, the rules every change follows, and how to add an emulator.

## Setup

- Node 24 or later and pnpm (the version in `package.json`).
- `pnpm install`, then `pnpm --filter emuhealth... build` to build the CLI and what it bundles.
- Run checks for the packages you touch, for example `cd packages/@emuhealth/fhir-core && pnpm test && pnpm type-check && pnpm lint`. Full-repo builds are heavy; CI runs the whole matrix.

## Rules for every change

- **Synthetic data only.** Never add real patient data, identifiers of real people, or data copied from real systems.
- **Licensed terminology stays out.** Do not bundle SNOMED CT, CPT, NUCC, NUBC, MedDRA, X12 code lists, or NDC data. Use public code systems (LOINC, ICD-10-CM, RxNorm, HCPCS Level II, CVX, UCUM) and say in the docs what is left out.
- **One change per pull request**, on its own branch. Roadmap items are ticked with the PR link when they ship.
- **Decision records.** Read [`docs/decisions/`](docs/decisions/) before changing structure, naming, or scope. Never rewrite an accepted record; add one that supersedes or refines it.
- **Docs with behavior.** A change to commands, flags, routes, behavior, or seed config updates `README.md`, the service's `skills/<name>/SKILL.md`, its page in `apps/web/content/docs/`, and the CLI `--help` in `packages/emuhealth/src/index.ts`.
- **Upstream files.** emuhealth is a soft fork of vercel-labs/emulate. Keep edits to upstream-owned files (`packages/@emulators/*`) minimal and isolated.
- **UI** pages use the shared render functions in `packages/@emulators/core/src/ui.ts`.
- **Style**: no emojis, and no `--` used as a dash in prose or comments.
- **Third-party code runs in CI**: validators, Inferno test kits, and client libraries run in the GitHub workflows, not on contributor machines.

## Adding an emulator

1. Check the real API first: public documentation, an official client, or a published specification you can test against. Write down what you could not verify.
2. Create `packages/@emuhealth/<name>` (private, bundled into the CLI) with `src/index.ts` exporting the plugin and `seedFromConfig`, and tests in `src/__tests__`.
3. Register it at the end of `packages/emuhealth/src/registry-health.ts`, so it takes the next port.
4. Patient-centric emulators draw people from fhir-core's `syntheticPeople` and join the shared population (decision 0018).
5. Add the docs page, skill, README line, config example in `emulate.config.example.yaml`, and CLI help.
6. Where a validator, test kit, or official client exists, add a CI gate in `.github/workflows/`.
7. Consider an example in `examples/` with a test that runs a real flow.

## Releases

Maintainers release with a single pull request; see the release section of `AGENTS.md`. The stability policy for 1.0 and later is decision [0024](docs/decisions/0024-stability-and-deprecation.md).
