import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findConfig } from "../config-loader.js";
import { scaffoldCommand } from "../commands/scaffold.js";
import { brandedEnv } from "../env.js";
import { resolveBaseUrl } from "../base-url.js";

const directories: string[] = [];
function project(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "emuhealth-branding-"));
  directories.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "{}");
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config discovery", () => {
  it("prefers emuhealth.config.* over the emulate names", () => {
    const dir = project(["emulate.config.yaml", "service-emulator.config.json", "emuhealth.config.json"]);
    expect(findConfig(undefined, dir)).toBe(join(dir, "emuhealth.config.json"));
  });

  it("falls back to emulate.config.*", () => {
    const dir = project(["emulate.config.yaml"]);
    expect(findConfig(undefined, dir)).toBe(join(dir, "emulate.config.yaml"));
  });

  it("still rejects ambiguous configs within one name family", () => {
    expect(() => findConfig(undefined, project(["emuhealth.config.yaml", "emuhealth.config.json"]))).toThrow(
      "Multiple config files found",
    );
    expect(() => findConfig(undefined, project(["emulate.config.yaml", "emulate.config.json"]))).toThrow(
      "Multiple config files found",
    );
  });

  it("scaffolds emuhealth.config.ts when no config exists", () => {
    const dir = project([]);
    scaffoldCommand("inventory", undefined, dir);
    expect(existsSync(join(dir, "emuhealth.config.ts"))).toBe(true);
    expect(existsSync(join(dir, "emulate.config.ts"))).toBe(false);
  });
});

describe("environment variables", () => {
  it("prefers EMUHEALTH_* and falls back to EMULATE_*", () => {
    vi.stubEnv("EMUHEALTH_PORT", "");
    vi.stubEnv("EMULATE_PORT", "5000");
    expect(brandedEnv("PORT")).toBe("5000");
    vi.stubEnv("EMUHEALTH_PORT", "6000");
    expect(brandedEnv("PORT")).toBe("6000");
  });

  it("uses EMUHEALTH_BASE_URL before EMULATE_BASE_URL", () => {
    vi.stubEnv("PORTLESS_URL", "");
    vi.stubEnv("EMULATE_BASE_URL", "https://{service}.legacy.test");
    expect(resolveBaseUrl({ service: "github", port: 4001 })).toBe("https://github.legacy.test");
    vi.stubEnv("EMUHEALTH_BASE_URL", "https://{service}.health.test");
    expect(resolveBaseUrl({ service: "github", port: 4001 })).toBe("https://github.health.test");
  });
});
