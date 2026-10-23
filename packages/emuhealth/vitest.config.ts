import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify("0.0.0-test"),
  },
  resolve: {
    // Health emulators bundle @emulators/core into their dist without its fonts; test against their source.
    alias: {
      "@emuhealth/fhir-core": source("../@emuhealth/fhir-core/src/index.ts"),
      "@emuhealth/epic": source("../@emuhealth/epic/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
