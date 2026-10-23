# 0015: Non-HTTP listeners

- Status: Accepted
- Date: 2026-10-23
- Refines: [0001](0001-soft-fork-strategy.md), [0005](0005-cli-package-layout.md)

## Context

HL7 v2 interfaces exchange messages over MLLP, a framing protocol on raw TCP, usually on port 2575. Every emulator so far is an HTTP app that the CLI serves with one listener per service, and the `ServicePlugin` interface in `@emulators/core` only knows about HTTP routes. An HL7 v2 emulator needs a second listener with the same lifecycle as the HTTP one: started with the service, sharing its store, and closed with it.

## Decision

- Services can open extra listeners through an optional `listen` hook on `LoadedService` in `packages/emuhealth/src/registry.ts`, not on `ServicePlugin` in core. The hook gets the service's store, webhooks, base URL, seed config, and host, and returns the URLs it listens on and a `close` function, or nothing when the config turns the listener off.
- `createEmulator` and `npx emuhealth start` call the hook after seeding, print its URLs in the banner, and close it on shutdown, on `close()`, and on startup rollback. `reset()` keeps listeners open; they read the store on every message.
- Listener ports come from the service's seed config (`hl7v2.mllp.port`), defaulting to the protocol's usual port, so the HTTP port scheme stays as it is.
- Listeners bind to the same host as the HTTP server, `127.0.0.1` by default.

## Consequences

- Upstream `@emulators/core` stays untouched; the change is confined to fork-owned CLI files that already differ from upstream.
- Framework adapters (Next.js, Nuxt) only mount HTTP routes, so services embedded that way have no MLLP listener. Their HTTP API still accepts messages.
- Any future TCP protocol (DIMSE, X12 over sockets) can use the same hook.
