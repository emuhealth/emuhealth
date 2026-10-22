# 0005: CLI package layout and publishing

- Status: Accepted
- Date: 2026-10-22
- Refines: [0002](0002-naming-and-publishing.md)

## Context

[0002](0002-naming-and-publishing.md) chose `emuhealth` as the CLI name. Implementing it raised three questions.

1. The CLI source lived in `packages/emulate`. A folder named `emulate` producing a package named `emuhealth` confuses contributors. That folder is also where most upstream changes land (46 of the last 55 upstream commits touch it), so renaming it affects every upstream merge.
2. 0002 said upstream `@emulators/*` packages would be consumed from npm. In fact the CLI lists them as `devDependencies` and bundles them into its build (`noExternal: [/^@emulators\//]` in `tsup.config.ts`). Fork changes to `@emulators/core` (for example new UI in `ui.ts`) therefore ship inside `emuhealth` without publishing anything under the `@emulators` scope.
3. Upstream is at version 0.12.x. Carrying that number over would suggest a history emuhealth does not have.

## Decision

- Rename the folder `packages/emulate` to `packages/emuhealth`. Git follows the rename on upstream merges, and `merge.directoryRenames=true` places new upstream files in the renamed folder (see [upstream sync](../upstream-sync.md)).
- Keep the `packages/@emulators/*` folders and package names unchanged. They are upstream's packages and the name is accurate.
- Publish only `emuhealth` and `@emuhealth/*`. Never publish `@emulators/*`. Health packages are bundled into the CLI the same way, and are also published individually so they can be used without the CLI.
- Start versioning at `0.1.0`. `scripts/sync-versions.mjs` keeps `@emuhealth/*` packages on the CLI version and leaves `@emulators/*` on their upstream versions.
- The CLI accepts imports from both `emuhealth` and `emulate` in project configs, so custom emulators written for upstream keep working.
- Internal names inherited from upstream (`emulate.config.*` files, `EMULATE_*` environment variables, `/_emulate` inspector routes, `.emulate.localhost` portless hosts) stay for now. Branded equivalents with fallbacks are a separate roadmap item.
- The release workflow runs only on manual trigger until npm trusted publishing is configured for `emuhealth`.

## Consequences

- `@emulators/adapter-next` and `@emulators/adapter-nuxt` are not available as emuhealth packages. If the framework adapters are needed, they must be published as `@emuhealth/adapter-next` and `@emuhealth/adapter-nuxt`, which requires a new decision.
- Upstream sync relies on git rename detection for the CLI folder. The sync guide documents the required setting.
