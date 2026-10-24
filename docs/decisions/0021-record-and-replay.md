# 0021: Record and replay

- Status: Accepted
- Date: 2026-10-24
- Refines: [0020](0020-fault-injection.md)

## Context

A session that worked against an emulator is a good regression test: if a later emuhealth release, or a change in the app's requests, changes the responses, the team wants to know. Writing those checks by hand for each flow is slow.

## Decision

- Any built-in service takes `record: true` or `record: { path }` in its seed config. `PUT /_emulate/recording` turns recording on or off at runtime, `GET` returns the exchanges as NDJSON, and `DELETE` clears them. With a `path`, each exchange is also appended to that file.
- An exchange holds the method, path and query, a few request headers (content negotiation, Prefer, and conditional headers), the request body, the status, a few response headers, and textual response bodies. The Authorization header is never recorded.
- Recording wraps the app's fetch handler, because the core router's middleware cannot read responses. Like fault injection, it is applied by the CLI around the service plugin.
- `npx emuhealth replay <file> --service <name> [--seed <file>] [--ignore keys]` replays a recording in order against a fresh emulator and exits with `1` when any response differs:
  - statuses are compared for every exchange;
  - JSON bodies are compared after dropping volatile keys (timestamps, generated tokens, reference numbers, and any `--ignore` keys) and the origin of absolute URLs;
  - ids the server assigned differently are mapped forward into later requests and comparisons;
  - other bodies, such as XML and ER7, are compared by status only.

## Consequences

- A captured session doubles as a regression test without writing assertions.
- Replay is as deterministic as the emulator: generated data with a fixed seed replays exactly, and random ids are handled by mapping.
