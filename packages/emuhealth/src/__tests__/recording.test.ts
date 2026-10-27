import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";
import { parseRecording, replayRecording } from "../recording.js";

const json = { "Content-Type": "application/fhir+json" };

describe("record and replay", () => {
  it("records a FHIR session and replays it cleanly against a fresh emulator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emu-record-"));
    const path = join(dir, "session.ndjson");
    const recorder = await createEmulator({ service: "fhir", port: 0, seed: { fhir: { record: { path } } } });
    try {
      const created = await fetch(`${recorder.url}/Patient`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ resourceType: "Patient", name: [{ family: "Recorded" }] }),
      });
      const id = ((await created.json()) as any).id;
      await fetch(`${recorder.url}/Patient/${id}`, {
        method: "PUT",
        headers: { ...json, "If-Match": 'W/"1"' },
        body: JSON.stringify({ resourceType: "Patient", id, name: [{ family: "Recorded" }], gender: "other" }),
      });
      await fetch(`${recorder.url}/Patient?family=Recorded`);
      await fetch(`${recorder.url}/Patient/${id}/_history`);
      await fetch(`${recorder.url}/Patient/missing`);

      const served = parseRecording(await (await fetch(`${recorder.url}/_emulate/recording`)).text());
      const written = parseRecording(readFileSync(path, "utf8"));
      expect(served).toHaveLength(5);
      expect(written).toEqual(served);
      expect(served[0].requestHeaders.authorization).toBeUndefined();

      const fresh = await createEmulator({ service: "fhir", port: 0 });
      try {
        expect(await replayRecording(served, fresh.url)).toEqual([]);
        const tampered = served.map((e, i) => (i === 4 ? { ...e, status: 200 } : e));
        const again = await createEmulator({ service: "fhir", port: 0 });
        try {
          const differences = await replayRecording(tampered, again.url);
          expect(differences).toEqual([expect.objectContaining({ index: 4, problem: "status 404, recorded 200" })]);
        } finally {
          await again.close();
        }
      } finally {
        await fresh.close();
      }
    } finally {
      await recorder.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns recording on at runtime", async () => {
    const fhir = await createEmulator({ service: "fhir", port: 0 });
    try {
      await fetch(`${fhir.url}/metadata`);
      expect(await (await fetch(`${fhir.url}/_emulate/recording`)).text()).toBe("");
      await fetch(`${fhir.url}/_emulate/recording`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "true",
      });
      await fetch(`${fhir.url}/metadata`);
      expect(parseRecording(await (await fetch(`${fhir.url}/_emulate/recording`)).text())).toHaveLength(1);
    } finally {
      await fhir.close();
    }
  });
});
