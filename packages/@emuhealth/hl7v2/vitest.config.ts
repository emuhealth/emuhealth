import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against fhir-core's source, not its bundled dist.
    alias: { "@emuhealth/fhir-core": fileURLToPath(new URL("../fhir-core/src/index.ts", import.meta.url)) },
  },
  test: {
    globals: true,
  },
});
