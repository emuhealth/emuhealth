// The app: /launch starts a standalone launch, /callback finishes it and shows the patient's summary.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeUrl, discover, exchangeCode, patientSummary, pkce, type PatientSummary } from "./smart.ts";

export interface AppOptions {
  fhirBase: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

function render(summary: PatientSummary): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `<li>${escape(i)}</li>`).join("") : "<li>None</li>";
  return `<!doctype html><title>Patient summary</title><h1>${escape(summary.name)}</h1>
<p>Born ${escape(summary.birthDate ?? "unknown")}, FHIR id ${escape(summary.id)}</p>
<h2>Conditions</h2><ul>${list(summary.conditions)}</ul>
<h2>Medications</h2><ul>${list(summary.medications)}</ul>`;
}

export function createApp(options: AppOptions) {
  const scope =
    options.scope ??
    "launch/patient openid fhirUser patient/Patient.rs patient/Condition.rs patient/MedicationRequest.rs";
  const pending = new Map<string, string>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://app");
    try {
      if (url.pathname === "/launch") {
        const config = await discover(options.fhirBase);
        const state = randomBytes(16).toString("hex");
        const { verifier, challenge } = pkce();
        pending.set(state, verifier);
        res.writeHead(302, { Location: authorizeUrl(config, { ...options, scope, state, challenge }) }).end();
        return;
      }
      if (url.pathname === "/callback") {
        const state = url.searchParams.get("state") ?? "";
        const verifier = pending.get(state);
        const code = url.searchParams.get("code");
        if (!verifier || !code) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(url.searchParams.get("error") ?? "Unknown state");
          return;
        }
        pending.delete(state);
        const config = await discover(options.fhirBase);
        const token = await exchangeCode(config, { ...options, code, verifier });
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(render(await patientSummary(options.fhirBase, token)));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<a href="/launch">Launch with Epic</a>');
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain" }).end((error as Error).message);
    }
  };
}
