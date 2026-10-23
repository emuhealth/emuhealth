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
      "@emuhealth/athena": source("../@emuhealth/athena/src/index.ts"),
      "@emuhealth/cerner": source("../@emuhealth/cerner/src/index.ts"),
      "@emuhealth/redcap": source("../@emuhealth/redcap/src/index.ts"),
      "@emuhealth/benchling": source("../@emuhealth/benchling/src/index.ts"),
      "@emuhealth/nppes": source("../@emuhealth/nppes/src/index.ts"),
      "@emuhealth/ncbi": source("../@emuhealth/ncbi/src/index.ts"),
      "@emuhealth/clinicaltrials": source("../@emuhealth/clinicaltrials/src/index.ts"),
      "@emuhealth/rxnav": source("../@emuhealth/rxnav/src/index.ts"),
      "@emuhealth/epic": source("../@emuhealth/epic/src/index.ts"),
      "@emuhealth/openfda": source("../@emuhealth/openfda/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
