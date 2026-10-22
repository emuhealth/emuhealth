# 0006: Repository protections

- Status: Accepted
- Date: 2026-10-22

## Context

Once the release workflow runs on every push to `main`, anything that lands on `main` with a new version is published to npm, and published versions cannot be replaced. Upstream protects against this with GitHub rulesets and a protected `Release` environment. These settings live in GitHub, not in the repository, so this record is the only place they are written down.

Branch rulesets are not available for private repositories on GitHub's free plan, and npm provenance requires a public repository. The repository was made public on 2026-10-22 for both reasons.

## Decision

Mirror upstream's settings:

| Setting                       | Upstream                                   | emuhealth                                    |
| ----------------------------- | ------------------------------------------ | -------------------------------------------- |
| Ruleset `Protected` on `main` | No deletion, no force push, PR required, squash only | Same                                 |
| Required approvals            | 1                                          | 0                                            |
| Required status checks        | None                                       | All 7 CI jobs                                |
| Signed commits                | Required on all branches                   | Same                                         |
| Signed tags                   | Required                                   | Same                                         |
| `Release` environment         | `main` only, maintainer approval           | `main` only, maintainer approval             |
| Merge methods                 | Squash                                     | Squash only, branches deleted after merge    |

Two deliberate differences:

- **0 approvals.** The project has one maintainer, and GitHub does not allow approving your own PR. Raise this to 1 when a second maintainer joins.
- **Required status checks.** They replace the missing reviewer: nothing reaches `main` unless `build-and-test`, both `Docs` jobs, and all four `custom-consumer` jobs pass. If a CI job is renamed or added, update the ruleset in the same PR or merges will block.

## Consequences

- Every change reaches `main` through a squash-merged PR with green CI. `gh pr merge --auto` merges once checks pass.
- Contributors must sign commits. Setup: `gpg.format = ssh`, `user.signingkey` set to a public key, `commit.gpgsign = true`, and the key added to GitHub as a Signing Key.
- npm trusted publishing for `emuhealth` is bound to the `Release` environment, so only the release workflow on `main`, approved by a maintainer, can publish.
- To inspect the live settings: `gh api repos/emuhealth/emuhealth/rulesets` and `gh api repos/emuhealth/emuhealth/environments/Release`.
