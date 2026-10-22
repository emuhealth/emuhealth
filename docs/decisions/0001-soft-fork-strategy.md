# 0001: Soft fork strategy and layout

- Status: Accepted
- Date: 2026-10-22

## Context

emuhealth is built on vercel-labs/emulate, which keeps shipping new emulators and core improvements. We want those changes, so we merge `upstream/main` regularly. Every upstream file we edit is a potential merge conflict.

Health apps also use many of the existing general-purpose emulators (Stripe, Twilio, Resend, Okta, Microsoft, Google).

## Decision

- Keep all upstream emulators. Do not delete or rename `packages/@emulators/*`.
- Put every health and life science emulator in `packages/@emuhealth/<name>`.
- Register health services in `packages/emulate/src/registry-health.ts` and merge them into `SERVICE_REGISTRY` with the smallest possible change to `registry.ts`.
- Shared UI goes into `packages/@emulators/core/src/ui.ts` as AGENTS.md requires. Prefer adding new functions and CSS classes over editing existing ones.
- Health services use a stable default port range starting at 4100. Today default ports are `base + index` (`packages/emulate/src/commands/start.ts`), so upstream adding a service would shift every port after it. Health services must get fixed defaults that do not depend on upstream order.
- Edits to upstream-owned files are allowed only when necessary and should be small and isolated, so they are easy to re-apply after a merge.

## Consequences

- Upstream merges stay mostly conflict-free.
- Rebranding (README, CLI help, docs site) touches upstream files and will conflict on sync. That is accepted and handled by the procedure in `docs/upstream-sync.md`.
- Two package namespaces exist side by side: `@emulators/*` (upstream) and `@emuhealth/*` (ours).
