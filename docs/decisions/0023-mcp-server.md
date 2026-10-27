# 0023: MCP server

- Status: Accepted
- Date: 2026-10-24
- Refines: [0020](0020-fault-injection.md), [0021](0021-record-and-replay.md)

## Context

Coding agents build and test health apps with emuhealth through the agent skills and the CLI. A Model Context Protocol server lets an agent manage emulators as tools instead of shell commands and background processes.

## Decision

- `npx emuhealth mcp` serves MCP over stdio: newline-delimited JSON-RPC 2.0, protocol versions `2025-06-18`, `2025-03-26`, and `2024-11-05`, tools only.
- The tools are `list_emulators`, `start_emulator`, `stop_emulator`, `reset_emulator`, `request`, `set_faults`, and `recording`. They use `createEmulator`, `/_emulate/faults`, and `/_emulate/recording`, so they behave like the CLI and the programmatic API.
- The server is part of the `emuhealth` CLI package and is written against the protocol directly, without an SDK dependency.
- Messages are processed in order, and emulators started by the session stop when stdin closes.

## Consequences

- Any MCP client can drive the emulators without extra setup.
- New emulator features reach agents by adding a tool here.
