# 0020: Fault injection

- Status: Accepted
- Date: 2026-10-24

## Context

Integrations fail in ways a happy path never shows: rate limits, outages, slow responses, expired tokens, and interface engines that drop a connection mid-message. Testing retry and backoff logic needs those failures on demand, for any emulator, without changing each one.

## Decision

- Any built-in service takes a `faults` key in its seed config: `latency` (`ms`, `jitterMs`), `rateLimit` (`requests` per `windowSeconds`, then `429` with `Retry-After`), `outage` (`status`, default `503`, at `probability`, with optional `retryAfterSeconds`), `expiredTokens` (`401` with `WWW-Authenticate: Bearer error="invalid_token"` for requests with a bearer token, at `probability`), and `paths` (prefixes to limit them to).
- `GET`, `PUT`, and `DELETE /_emulate/faults` read, replace, and clear a running service's faults, so a test can switch an outage on and off.
- The CLI applies faults by wrapping the service plugin, registering the fault middleware before the service's routes. Neither the emulators nor `@emulators/core` change.
- Failures carry `X-Emulate-Fault`. FHIR clients (an `Accept` or `Content-Type` with `fhir+json`) get an OperationOutcome; others get `{ "error", "message" }`.
- `/_emulate` and `/_inspector` paths are never faulted.
- HL7 v2's MLLP listener has its own `mllp.dropRate`, which closes the connection without applying the message or sending an ACK, and `mllp.ackDelayMs`.

## Consequences

- Retry, backoff, and token refresh logic can be tested against every emulator the same way.
- Failure bodies are generic rather than each vendor's exact error format; the status codes and headers are what clients key on.
