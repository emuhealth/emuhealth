import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against the shared packages' source, not their bundled dist.
    alias: {
      "@emuhealth/fhir-core": source("../fhir-core/src/index.ts"),
      "@emuhealth/device-core": source("../device-core/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
