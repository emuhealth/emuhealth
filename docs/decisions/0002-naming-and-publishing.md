# 0002: Naming and npm publishing

- Status: Accepted
- Date: 2026-10-22

## Context

The upstream packages `emulate` and `@emulators/*` belong to Vercel on npm, so we cannot publish under those names. Availability check on 2026-10-22:

| Name                  | Result                                         |
| --------------------- | ---------------------------------------------- |
| `emuhealth` (package) | Available                                      |
| `@emuhealth` (scope)  | Registered, no published packages yet          |
| `emuhealth` (GitHub)  | Organization exists, hosts this repository     |

The `emulate` binary name also clashes with a zsh built-in, which forces `npx emulate` everywhere.

## Decision

- CLI package and binary: `emuhealth`, invoked as `npx emuhealth`.
- Health emulator packages: `@emuhealth/<name>` (for example `@emuhealth/fhir-core`, `@emuhealth/epic`).
- Upstream `@emulators/*` packages are consumed from upstream as they are, not republished under our names, unless a later decision requires patching them.
- All emuhealth packages share one version number, following the upstream release model in AGENTS.md.
- Before the first publish, confirm the `@emuhealth` npm scope is owned by us. If it is not, fall back to `@emuhealth-dev` and record that in a new decision.

## Consequences

- No zsh clash: docs can use `npx emuhealth` or `emuhealth` directly.
- The release workflow, `scripts/sync-versions.mjs`, and package metadata must be updated in Phase 0.
- Apache-2.0 requires keeping the upstream license and copyright and stating our modifications in a `NOTICE` file.
