import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";
import { SERVICE_REGISTRY, SERVICE_NAMES, DEFAULT_TOKENS, type ServiceName } from "../registry.js";
import { CONFIG_FILES } from "../config-loader.js";

interface InitOptions {
  service: string;
}

export function initCommand(options: InitOptions): void {
  const filename = "emuhealth.config.yaml";
  const fullPath = resolve(filename);

  const existing = CONFIG_FILES.find((name) => existsSync(resolve(name)));
  if (existing) {
    console.error(`Config file already exists: ${existing}`);
    process.exit(1);
  }

  let config: Record<string, unknown>;
  if (options.service === "all") {
    config = { ...DEFAULT_TOKENS };
    for (const name of SERVICE_NAMES) {
      Object.assign(config, SERVICE_REGISTRY[name].initConfig);
    }
  } else {
    const entry = SERVICE_REGISTRY[options.service as ServiceName];
    if (!entry) {
      console.error(`Unknown service: ${options.service}. Available: ${SERVICE_NAMES.join(", ")}, all`);
      process.exit(1);
    }
    config = { ...DEFAULT_TOKENS, ...entry.initConfig };
  }

  const content = yamlStringify(config);
  writeFileSync(fullPath, content, "utf-8");

  console.log(`Created ${filename}`);
  console.log(`\nRun 'npx emuhealth' to start the emulator.`);
}
