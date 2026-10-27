import { describe, expect, it } from "vitest";
import { EmulatorSession, handleMessage, PROTOCOL_VERSIONS } from "../mcp.js";

const rpc = (session: EmulatorSession, method: string, params?: unknown, id: number | undefined = 1) =>
  handleMessage(session, { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }, "0.0.0-test");
const toolResult = (response: any) => JSON.parse(response.result.content[0].text);

describe("MCP server", () => {
  it("initializes and lists its tools", async () => {
    const session = new EmulatorSession();
    const init = await rpc(session, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test" },
    });
    expect(init!.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "emuhealth" },
      capabilities: { tools: {} },
    });
    const fallback = await rpc(session, "initialize", { protocolVersion: "1999-01-01" });
    expect(fallback!.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(
      await handleMessage(session, { jsonrpc: "2.0", method: "notifications/initialized" }, "0.0.0-test"),
    ).toBeUndefined();
    const list = await rpc(session, "tools/list");
    expect(list!.result.tools.map((t: any) => t.name)).toEqual([
      "list_emulators",
      "start_emulator",
      "stop_emulator",
      "reset_emulator",
      "request",
      "set_faults",
      "recording",
    ]);
    expect((await rpc(session, "nope"))!.error.code).toBe(-32601);
  });

  it("starts, calls, faults, records, resets, and stops an emulator", async () => {
    const session = new EmulatorSession();
    try {
      const call = (name: string, args: unknown) => rpc(session, "tools/call", { name, arguments: args });
      const started = toolResult(
        await call("start_emulator", { service: "fhir", seed: { fhir: { generate: { patients: 2 } } } }),
      );
      expect(started.url).toMatch(/^http:\/\/localhost:\d+$/);
      const patients = toolResult(await call("request", { service: "fhir", path: "/Patient" }));
      expect(patients).toMatchObject({ status: 200, body: { total: 2 } });
      const created = toolResult(
        await call("request", { service: "fhir", method: "POST", path: "/Patient", body: { resourceType: "Patient" } }),
      );
      expect(created.status).toBe(201);

      expect(
        toolResult(await call("set_faults", { service: "fhir", faults: { outage: { status: 503 } } })).status,
      ).toBe(200);
      expect(toolResult(await call("request", { service: "fhir", path: "/Patient" })).status).toBe(503);
      await call("set_faults", { service: "fhir", faults: {} });

      await call("recording", { service: "fhir", action: "start" });
      await call("request", { service: "fhir", path: "/metadata" });
      expect(JSON.stringify(toolResult(await call("recording", { service: "fhir", action: "read" })).body)).toContain(
        "/metadata",
      );

      await call("reset_emulator", { service: "fhir" });
      expect(toolResult(await call("request", { service: "fhir", path: "/Patient" })).body.total).toBe(2);
      const listed = toolResult(await call("list_emulators", {}));
      expect(listed.find((e: any) => e.name === "fhir").running).toBe(started.url);

      await call("stop_emulator", { service: "fhir" });
      const gone = await call("request", { service: "fhir", path: "/Patient" });
      expect(gone!.result.isError).toBe(true);
      expect((await call("start_emulator", { service: "nope" }))!.result.isError).toBe(true);
    } finally {
      await session.closeAll();
    }
  });
});
