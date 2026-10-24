import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { authorizeUrl, exchangeCode, syncGlucose } from "./sync.ts";

// Plays the user on Dexcom's consent page: picks the first synthetic user.
async function consent(url: string, origin: string): Promise<string> {
  const page = await fetch(url, { redirect: "manual" });
  const html = await page.text();
  const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  assert.ok(form, `Unexpected consent page (${page.status})`);
  const fields = Object.fromEntries(
    [...form[2].matchAll(/<(?:input|button)[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  const res = await fetch(new URL(form[1], origin), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

test("copies a day of CGM readings into FHIR once", async () => {
  const dexcom = await createEmulator({ service: "dexcom", port: 0 });
  const fhir = await createEmulator({ service: "fhir", port: 0 });
  try {
    const app = {
      baseUrl: dexcom.url,
      clientId: "example",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/callback",
    };
    const token = await exchangeCode(app, await consent(authorizeUrl(app, "s1"), dexcom.url));
    const window = { start: "2026-01-10T00:00:00", end: "2026-01-11T00:00:00" };
    const options = { dexcomUrl: dexcom.url, token, fhirBase: fhir.url, patientId: "syn-patient-001", ...window };

    const first = await syncGlucose(options);
    assert.ok(first >= 288, `expected a day of 5 minute readings, got ${first}`);
    assert.equal(await syncGlucose(options), 0);

    const stored = (await (
      await fetch(`${fhir.url}/Observation?code=http://loinc.org|99504-3&patient=syn-patient-001&_summary=count`)
    ).json()) as { total: number };
    assert.equal(stored.total, first);
  } finally {
    await dexcom.close();
    await fhir.close();
  }
});
