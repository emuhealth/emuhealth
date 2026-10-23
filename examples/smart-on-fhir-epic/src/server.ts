// Runs the app on http://localhost:3000 against an Epic emulator started with `npm run emulator`.
import { createServer } from "node:http";
import { createApp } from "./app.ts";

const fhirBase = process.env.FHIR_BASE ?? "http://localhost:4101/api/FHIR/R4";
const port = Number(process.env.PORT ?? 3000);
createServer(createApp({ fhirBase, clientId: "my-epic-app", redirectUri: `http://localhost:${port}/callback` })).listen(
  port,
  () => console.log(`Open http://localhost:${port}/launch`),
);
