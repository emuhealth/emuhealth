import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEmulator, type SeedConfig } from "../api.js";
import { SERVICE_REGISTRY, type ServiceName } from "../registry.js";
import { parseRecording, replayRecording } from "../recording.js";
import { loadSeedConfig } from "./start.js";

export interface ReplayOptions {
  service: string;
  seed?: string;
  ignore?: string;
}

/** Replay a recording against a fresh emulator; exits with 1 when any response differs. */
export async function replayCommand(file: string, options: ReplayOptions): Promise<void> {
  if (!SERVICE_REGISTRY[options.service as ServiceName]) throw new Error(`Unknown service: ${options.service}`);
  const exchanges = parseRecording(readFileSync(resolve(file), "utf8"));
  const seed = (loadSeedConfig(options.seed)?.config ?? undefined) as SeedConfig | undefined;
  // Recording again while replaying would append to the file being replayed.
  const svcConfig = seed?.[options.service] as Record<string, unknown> | undefined;
  if (svcConfig) delete svcConfig.record;
  const emulator = await createEmulator({ service: options.service as ServiceName, port: 0, seed });
  try {
    const differences = await replayRecording(exchanges, emulator.url, {
      ignore: options.ignore
        ?.split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    });
    for (const d of differences) console.log(`#${d.index + 1} ${d.method} ${d.url}: ${d.problem}`);
    console.log(`Replayed ${exchanges.length} exchanges against ${options.service}: ${differences.length} differ.`);
    if (differences.length) process.exitCode = 1;
  } finally {
    await emulator.close();
  }
}
