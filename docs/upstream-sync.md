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
2. Check that no file was recreated under `packages/emulate/`. If one was, move it into `packages/emuhealth/`.
3. Search the incoming diff for new user-facing references to the old name (`npx emulate`, `from "emulate"`, `npm install emulate`) and change them to `emuhealth`.
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
| `.github/workflows/release.yml`           | Publishes `emuhealth` and `@emuhealth/*` only     |
| `scripts/*.mjs`                           | Package name and version sync targets             |
| `AGENTS.md`                               | Fork rules, CLI name, release process             |
| `README.md`, `skills/`, `apps/web/`       | Command and import names                          |

Keep this table current when a PR adds a new deliberate divergence.
