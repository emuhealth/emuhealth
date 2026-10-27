import { createInterface } from "node:readline";
import { createEmulator, type Emulator, type SeedConfig } from "./api.js";
import { HEALTH_SERVICE_NAMES, HEALTH_SERVICE_REGISTRY, defaultServicePort } from "./registry-health.js";
import type { ServiceName } from "./registry.js";
import { SYNTHETIC_DATA_NOTICE } from "./data-policy.js";

// An MCP server over stdio (decision 0023) so coding agents can start, seed, call, inspect, fault, and reset the
// emulators. It speaks newline-delimited JSON-RPC 2.0 as the MCP stdio transport defines, with tools only.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 20_000;

type Json = Record<string, any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run(args: Json): Promise<unknown>;
}

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export class EmulatorSession {
  readonly running = new Map<string, Emulator>();

  async start(service: string, port?: number, seed?: SeedConfig): Promise<Emulator> {
    if (!HEALTH_SERVICE_NAMES.includes(service as never)) throw new Error(`Unknown service: ${service}`);
    const existing = this.running.get(service);
    if (existing) return existing;
    const emulator = await createEmulator({ service: service as ServiceName, port: port ?? 0, seed });
    this.running.set(service, emulator);
    return emulator;
  }

  get(service: string): Emulator {
    const emulator = this.running.get(service);
    if (!emulator) throw new Error(`${service} is not running; start it with start_emulator`);
    return emulator;
  }

  async stop(service: string): Promise<void> {
    await this.get(service).close();
    this.running.delete(service);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((e) => e.close()));
    this.running.clear();
  }
}

async function call(
  emulator: Emulator,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(new URL(path, emulator.url), {
    method,
    headers: {
      ...(body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: keep the text.
  }
  const shown = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body:
      shown.length > MAX_BODY
        ? `${shown.slice(0, MAX_BODY)}\n... (${shown.length - MAX_BODY} more characters)`
        : parsed,
  };
}

export function tools(session: EmulatorSession): Tool[] {
  const service = {
    type: "string",
    enum: [...HEALTH_SERVICE_NAMES],
    description: "Emulator name, such as fhir or epic",
  };
  return [
    {
      name: "list_emulators",
      description: "List the health and life science emulators, their default ports, and which are running here.",
      inputSchema: { type: "object", properties: {} },
      run: async () =>
        HEALTH_SERVICE_NAMES.map((name, i) => ({
          name,
          label: HEALTH_SERVICE_REGISTRY[name].label,
          defaultPort: defaultServicePort(name, 4000, i),
          running: session.running.get(name)?.url ?? null,
        })),
    },
    {
      name: "start_emulator",
      description: `Start an emulator and return its base URL. Optional seed is the same config the CLI takes (for example { "fhir": { "generate": { "patients": 10 } } } or { "population": { "scenarios": ["diabetes-cgm"] } }). ${SYNTHETIC_DATA_NOTICE}`,
      inputSchema: {
        type: "object",
        properties: {
          service,
          port: { type: "integer", description: "Port to listen on; omit for a free port" },
          seed: { type: "object", description: "Seed config keyed by service name, plus population and tokens" },
        },
        required: ["service"],
      },
      run: async (args) => {
        const emulator = await session.start(args.service, args.port, args.seed);
        return { service: args.service, url: emulator.url };
      },
    },
    {
      name: "stop_emulator",
      description: "Stop a running emulator.",
      inputSchema: { type: "object", properties: { service }, required: ["service"] },
      run: async (args) => {
        await session.stop(args.service);
        return { stopped: args.service };
      },
    },
    {
      name: "reset_emulator",
      description: "Reset a running emulator to its seed data.",
      inputSchema: { type: "object", properties: { service }, required: ["service"] },
      run: async (args) => {
        session.get(args.service).reset();
        return { reset: args.service };
      },
    },
    {
      name: "request",
      description:
        "Send an HTTP request to a running emulator and return the status and body. Use it to read and write data, for example GET /Patient?_count=5 on fhir.",
      inputSchema: {
        type: "object",
        properties: {
          service,
          method: { type: "string", default: "GET" },
          path: { type: "string", description: "Path and query, such as /Patient/syn-patient-001" },
          body: { description: "JSON body, or a string for XML, HL7 v2, or form bodies" },
          headers: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["service", "path"],
      },
      run: (args) => call(session.get(args.service), args.method ?? "GET", args.path, args.body, args.headers),
    },
    {
      name: "set_faults",
      description:
        "Set fault injection on a running emulator: latency { ms }, rateLimit { requests, windowSeconds }, outage { status, probability }, expiredTokens { probability }, paths. An empty object clears them.",
      inputSchema: {
        type: "object",
        properties: { service, faults: { type: "object" } },
        required: ["service", "faults"],
      },
      run: async (args) => {
        const emulator = session.get(args.service);
        return Object.keys(args.faults ?? {}).length
          ? call(emulator, "PUT", "/_emulate/faults", args.faults)
          : call(emulator, "DELETE", "/_emulate/faults");
      },
    },
    {
      name: "recording",
      description:
        "Turn request recording on or off for a running emulator, or read what it recorded as NDJSON (action: start, stop, read, or clear).",
      inputSchema: {
        type: "object",
        properties: { service, action: { type: "string", enum: ["start", "stop", "read", "clear"] } },
        required: ["service", "action"],
      },
      run: async (args) => {
        const emulator = session.get(args.service);
        if (args.action === "read") return call(emulator, "GET", "/_emulate/recording");
        if (args.action === "clear") return call(emulator, "DELETE", "/_emulate/recording");
        return call(emulator, "PUT", "/_emulate/recording", args.action === "start");
      },
    },
  ];
}

/** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
export async function handleMessage(
  session: EmulatorSession,
  message: Json,
  version: string,
): Promise<Json | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: msg },
  });
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request");
  const isNotification = message.id === undefined;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "emuhealth", version },
        instructions: `Start emulators with start_emulator, then call them with request. ${SYNTHETIC_DATA_NOTICE}`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools(session).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = tools(session).find((t) => t.name === message.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${message.params?.name}`);
      try {
        return reply(text(await tool.run(message.params?.arguments ?? {})));
      } catch (error) {
        return reply({ ...text((error as Error).message), isError: true });
      }
    }
    default:
      return isNotification ? undefined : fail(-32601, `Method not found: ${message.method}`);
  }
}

/** Serve MCP over stdin and stdout until stdin closes. Logs go to stderr. */
export async function serveMcp(version: string): Promise<void> {
  const session = new EmulatorSession();
  const lines = createInterface({ input: process.stdin });
  // Messages are handled in order, so a call never overtakes the start_emulator before it.
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let message: Json;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
        );
        return;
      }
      const response = await handleMessage(session, message, version);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => lines.on("close", resolve));
  await queue;
  await session.closeAll();
}
