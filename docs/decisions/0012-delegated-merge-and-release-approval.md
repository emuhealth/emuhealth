# 0012: Delegated merge and release approval

- Status: Accepted
- Date: 2026-10-23
- Refines: [0006](0006-repository-protections.md)

## Context

[0006](0006-repository-protections.md) relies on two human steps: the maintainer merges pull requests, and the maintainer approves the `Release` environment before anything is published to npm. Day to day, the maintainer ran both as commands that Claude Code (the coding agent working on this repository) prepared after CI passed.

## Decision

- The maintainer authorizes Claude Code, running locally under the maintainer's account, to merge `emuhealth/emuhealth` pull requests and to approve the `Release` environment for release workflow runs.
- The authorization is a local Claude Code permission setting on the maintainer's machine (`.claude/settings.local.json`, not committed). It can be withdrawn by removing those rules.
- Nothing in GitHub changes: the `Protected` ruleset, required status checks, signed commits, squash-only merges, and the `Release` environment with required reviewer stay as described in [0006](0006-repository-protections.md).
- Claude Code merges only when every required check passes on the latest commit, approves a release only for a merged prepare-release PR, then verifies the npm version, provenance, and GitHub release, and reports what shipped.

## Consequences

- Work goes from branch to published release without waiting on manual commands.
- Approvals are recorded under the maintainer's GitHub account, so the audit trail does not distinguish who pressed approve; this record and the commit and PR attribution explain it.
- Adding a second maintainer, or publishing more packages, is a reason to revisit this record.
