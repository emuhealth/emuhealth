import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { createApp } from "./app.ts";

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

// Plays the user in the browser: submits the first choice on each sign in page until the emulator redirects back.
async function signIn(authorizeUrl: string, origin: string): Promise<string> {
  let res = await fetch(authorizeUrl, { redirect: "manual" });
  for (let step = 0; step < 5; step++) {
    const location = res.headers.get("location");
    if (location) return location;
    const html = await res.text();
    const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
    assert.ok(form, `Unexpected sign in page (${res.status})`);
    const fields = Object.fromEntries(
      [...form[2].matchAll(/<(?:input|button)[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    const action = form[1];
    res = await fetch(new URL(action, origin), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
  throw new Error("The sign in did not finish");
}

test("standalone launch shows the patient's summary from Epic", async () => {
  const epic = await createEmulator({ service: "epic", port: 0 });
  const server = createServer();
  try {
    const appUrl = await listen(server);
    const fhirBase = `${epic.url}/api/FHIR/R4`;
    server.on("request", createApp({ fhirBase, clientId: "example-app", redirectUri: `${appUrl}/callback` }));

    const launch = await fetch(`${appUrl}/launch`, { redirect: "manual" });
    assert.equal(launch.status, 302);
    const callback = await signIn(launch.headers.get("location")!, epic.url);
    assert.ok(callback.startsWith(`${appUrl}/callback?code=`));

    const page = await fetch(callback);
    const html = await page.text();
    assert.equal(page.status, 200, html);
    assert.match(html, /<h1>[^<]+<\/h1>/);
    assert.match(html, /FHIR id syn-patient-/);
    assert.match(html, /<h2>Conditions<\/h2><ul><li>/);

    // The state is single use.
    assert.equal((await fetch(callback)).status, 400);
  } finally {
    server.close();
    await epic.close();
  }
});
