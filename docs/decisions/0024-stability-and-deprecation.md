# 0024: Stability and deprecation policy for 1.0

- Status: Accepted
- Date: 2026-10-24

## Context

Teams build test suites, CI pipelines, and agent workflows on emuhealth. Before 1.0, any release could change ports, config keys, or generated data. A 1.0 release needs a clear statement of what stays compatible, so upgrades are safe within a major version.

## Decision

From 1.0.0, emuhealth follows semantic versioning for this public surface:

- **CLI**: commands (`start`, `init`, `list`, `replay`, `mcp`), their flags, and exit codes. The start banner's service URL lines (`  <name>  <url>`) and the final `Ready.` line are stable, since the GitHub Action and the testing guide read them.
- **Config**: the top-level keys (`services`, `tokens`, `watch`, `population`) and every documented per-service key, in YAML, JSON, and TypeScript configs.
- **Ports**: default ports for every service. Health services keep their position in the registry, so new services only append ports.
- **Programmatic API**: the exports of the `emuhealth` package (`createEmulator`, `defineConfig`, and their types).
- **Control routes**: `/_emulate/faults`, `/_emulate/recording`, and the other documented `/_emulate` routes.
- **The container image and the GitHub Action** inputs and outputs.
- **Generated data**: for a given `seed`, the ids and demographics of each generated person and the ids of their records stay the same within a major version. Minor releases may add records and fix codes or displays to match the standards.

Emulated vendor and standard APIs follow the real services: a change that makes an emulator behave more like the real API is a fix and can ship in a minor release, with a changelog entry.

Outside the contract: inspector pages, log output other than the lines above, the private `@emuhealth/*` packages bundled into the CLI, and upstream services inherited from emulate.

Deprecation:

- Anything in the contract is deprecated before it is removed. A deprecated feature keeps working for at least one minor release, prints a warning to stderr when used, and is listed in the changelog and the upgrade guide.
- Removals happen only in a major release, and each major release has a section in the upgrade guide.

## Consequences

- Users can take minor and patch releases without changing their tests, except to pick up fixes that make emulators more faithful.
- Changes to ports, config keys, or generated ids wait for a major release, so new behavior is added alongside the old.
