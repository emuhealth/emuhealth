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
      "@emuhealth/rave": source("../@emuhealth/rave/src/index.ts"),
      "@emuhealth/veeva": source("../@emuhealth/veeva/src/index.ts"),
      "@emuhealth/hl7v2": source("../@emuhealth/hl7v2/src/index.ts"),
      "@emuhealth/dicomweb": source("../@emuhealth/dicomweb/src/index.ts"),
      "@emuhealth/terra": source("../@emuhealth/terra/src/index.ts"),
      "@emuhealth/withings": source("../@emuhealth/withings/src/index.ts"),
      "@emuhealth/oura": source("../@emuhealth/oura/src/index.ts"),
      "@emuhealth/fitbit": source("../@emuhealth/fitbit/src/index.ts"),
      "@emuhealth/device-core": source("../@emuhealth/device-core/src/index.ts"),
      "@emuhealth/dexcom": source("../@emuhealth/dexcom/src/index.ts"),
      "@emuhealth/availity": source("../@emuhealth/availity/src/index.ts"),
      "@emuhealth/stedi": source("../@emuhealth/stedi/src/index.ts"),
      "@emuhealth/azurehealth": source("../@emuhealth/azurehealth/src/index.ts"),
      "@emuhealth/gcphealthcare": source("../@emuhealth/gcphealthcare/src/index.ts"),
      "@emuhealth/healthlake": source("../@emuhealth/healthlake/src/index.ts"),
      "@emuhealth/redox": source("../@emuhealth/redox/src/index.ts"),
      "@emuhealth/cdshooks": source("../@emuhealth/cdshooks/src/index.ts"),
      "@emuhealth/bluebutton": source("../@emuhealth/bluebutton/src/index.ts"),
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
