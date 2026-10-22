# 0007: Branded config and environment names

- Status: Accepted
- Date: 2026-10-23
- Refines: [0005](0005-cli-package-layout.md)

## Context

[0005](0005-cli-package-layout.md) kept the upstream names `emulate.config.*` and `EMULATE_*` and deferred branded equivalents. Users of emuhealth should see emuhealth names, but projects and CI setups written for upstream emulate must keep working without changes.

## Decision

- Config discovery looks for `emuhealth.config.{ts,mts,js,mjs,yaml,yml,json}` first. If any is present, only those are considered. Otherwise discovery falls back to the upstream `emulate.config.*` and `service-emulator.config.*` names. Two files within the chosen family are still an error that asks for `--config`.
- `npx emuhealth init` writes `emuhealth.config.yaml` and refuses to run if any recognized config file already exists. `npx emuhealth init --custom` creates `emuhealth.config.ts` when no config exists, and updates an existing one of either name.
- Environment variables use `EMUHEALTH_<NAME>` and fall back to `EMULATE_<NAME>` when the branded variable is unset or empty: `EMUHEALTH_PORT`, `EMUHEALTH_BASE_URL`, `EMUHEALTH_DEBUG`.
- Out of scope and unchanged: `/_emulate` inspector routes, `.emulate.localhost` portless hosts, `// @emulate:*` scaffold markers, and the `emulate.config.example.yaml` file name. Renaming them would break clients or add upstream merge conflicts for little user benefit.

## Consequences

- Docs and generated files use the emuhealth names. Upstream per-service skills that mention `emulate.config.yaml` stay correct through the fallback and are left as they are to avoid merge conflicts.
- A project containing both an `emuhealth.config.*` and an `emulate.config.*` file silently uses the emuhealth one. This is documented in the configuration docs.
