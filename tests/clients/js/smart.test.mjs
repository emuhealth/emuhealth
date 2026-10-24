// The SMART on FHIR JavaScript client (fhirclient) in a Node app: standalone launch against the Epic and Oracle
// Health emulators, then patient reads through the client.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { smart } from "fhirclient/node";
import { signIn } from "./browser.mjs";

const SERVERS = [
  { name: "Epic", iss: "http://localhost:4101/api/FHIR/R4" },
  { name: "Oracle Health", iss: "http://localhost:4109/r4/5e7e0000-0000-4000-8000-000000000001" },
];

for (const { name, iss } of SERVERS)
  test(`standalone launch and patient reads against ${name}`, async () => {
    const session = {};
    const server = createServer(async (req, res) => {
      req.session = session;
      const url = new URL(req.url, `http://${req.headers.host}`);
      try {
        if (url.pathname === "/launch")
          return await smart(req, res).authorize({
            iss,
            clientId: "fhirclient-contract",
            scope: "launch/patient openid fhirUser patient/*.read",
            redirectUri: `http://${req.headers.host}/callback`,
          });
        if (url.pathname === "/callback") {
          const client = await smart(req, res).ready();
          const patient = await client.patient.read();
          const conditions = await client.patient.request("Condition");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ id: client.patient.id, patient, conditions }));
        }
        res.writeHead(404).end();
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error?.stack ?? error));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const app = `http://127.0.0.1:${server.address().port}`;
    try {
      const launch = await fetch(`${app}/launch`, { redirect: "manual" });
      assert.equal(launch.status, 302, await launch.text());
      const callback = await signIn(launch.headers.get("location"), `${app}/callback`);
      const res = await fetch(callback);
      const body = await res.text();
      assert.equal(res.status, 200, body);
      const result = JSON.parse(body);
      assert.match(result.id, /^syn-patient-/);
      assert.equal(result.patient.resourceType, "Patient");
      assert.equal(result.patient.id, result.id);
      assert.equal(result.conditions.resourceType, "Bundle");
    } finally {
      server.close();
    }
  });
