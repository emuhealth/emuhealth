// Runs the bridge on MLLP port 2576, writing to the FHIR emulator started with `npm run emulators`.
import { createBridge } from "./bridge.ts";

const fhirBase = process.env.FHIR_BASE ?? "http://localhost:4100";
const port = Number(process.env.MLLP_PORT ?? 2576);
createBridge({ fhirBase }).listen(port, "127.0.0.1", () =>
  console.log(`MLLP bridge on 127.0.0.1:${port} -> ${fhirBase}`),
);
