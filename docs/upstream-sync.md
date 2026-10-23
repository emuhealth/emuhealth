# Syncing with Upstream

emuhealth is a soft fork of [vercel-labs/emulate](https://github.com/vercel-labs/emulate). Merge upstream regularly so fixes and new emulators flow in. See [decision 0001](decisions/0001-soft-fork-strategy.md) for why the fork is laid out the way it is.

## One-time setup

```bash
git remote add upstream https://github.com/vercel-labs/emulate.git
git config merge.directoryRenames true
git config merge.renameLimit 10000
```

`merge.directoryRenames true` matters because this fork renamed `packages/emulate` to `packages/emuhealth` ([decision 0005](decisions/0005-cli-package-layout.md)). With it, files upstream adds under `packages/emulate/` land in `packages/emuhealth/` instead of being reported as conflicts.

## Procedure

```bash
git checkout main && git pull --ff-only
git fetch upstream
git log --oneline main..upstream/main   # review what is coming in
git checkout -b sync/upstream-YYYY-MM-DD
git merge upstream/main
```

Then:

1. Resolve conflicts. Expected hot spots are listed below.
2. Check that no file was recreated under `packages/emulate/` or `skills/emulate/`. If one was, move it into `packages/emuhealth/` or `skills/emuhealth/`.
3. Search the incoming diff for new user-facing references to the old name (`npx emulate`, `from "emulate"`, `npm install emulate`, `emulate.dev`, `github.com/vercel-labs/emulate`) and change them to the emuhealth equivalents.
4. Run `pnpm install`, `pnpm build`, `pnpm type-check`, `pnpm lint`, `pnpm test`, and `node scripts/sync-versions.mjs --check`.
5. Open a PR titled `Sync upstream YYYY-MM-DD`. Merge it with a merge commit, not a squash, so later merges know which upstream commits are already in.

## Files the fork changes

These diverge from upstream on purpose and are where conflicts are most likely:

| File                                      | Fork change                                       |
| ----------------------------------------- | ------------------------------------------------- |
| `packages/emuhealth/package.json`         | Name, binary, version, repository fields          |
| `packages/emuhealth/src/index.ts`         | CLI name and help text                            |
| `packages/emuhealth/src/project-loader.ts` | Accepts `emuhealth` imports                       |
| `packages/emuhealth/src/commands/*.ts`    | Banner and printed commands                       |
| `packages/emuhealth/src/registry.ts`      | Merges `registry-health.ts` into `SERVICE_REGISTRY` |
| `packages/emuhealth/src/{commands/start,project-runner,api}.ts` | Default ports via `defaultServicePort` |
| `packages/emuhealth/src/{config-loader,base-url}.ts` | `emuhealth.config.*` and `EMUHEALTH_*` names ([decision 0007](decisions/0007-branded-config-and-env-names.md)) |
| `packages/@emulators/core/src/ui.ts`      | emuhealth links in `emuBar()`, footer, and page titles; `.inspector-section a` link style |
| `packages/@emulators/core/src/index.ts`   | Exports `renderJsonDetails` for the FHIR inspector |
| `packages/@emulators/core/src/debug.ts`   | Also reads `EMUHEALTH_DEBUG`                      |
| `.github/workflows/release.yml`           | Publishes `emuhealth` and non-private `@emuhealth/*` only |
| `pnpm-workspace.yaml`                     | Adds `packages/@emuhealth/*`                      |
| `packages/emuhealth/tsup.config.ts`, `package.json` | Bundles `@emuhealth/*` into the CLI ([decision 0008](decisions/0008-fhir-core-design.md)) |
| `emulate.config.example.yaml`             | `fhir` section                                    |
| `THIRD_PARTY_NOTICES.md`                  | Clinical terminology attribution ([decision 0009](decisions/0009-synthetic-patient-generator.md)) |
| `scripts/*.mjs`                           | Package name and version sync targets             |
| `AGENTS.md`                               | Fork rules, CLI name, release process             |
| `CHANGELOG.md`                            | emuhealth entries above emulate's history; upstream's new entries go below the "emulate's own history" line |
| `README.md`, `skills/`, `apps/web/`       | Command and import names                          |
| `skills/emulate/` renamed to `skills/emuhealth/` | Skill name `emuhealth`                 |
| `apps/web/`                               | Branding, `www.emuhealth.dev` site URL, Vercel mark hidden in the navbar |

Keep this table current when a PR adds a new deliberate divergence.
