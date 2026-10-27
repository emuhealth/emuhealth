import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { bluebuttonPlugin, seedFromConfig, syntheticMbi, type BlueButtonSeedConfig } from "../index.js";

const origin = "http://localhost:4111";
const base = `${origin}/v2/fhir`;
const redirect = "http://localhost:3000/callback";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function startService(config?: BlueButtonSeedConfig) {
  const app = new Hono();
  const store = new Store();
  bluebuttonPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  bluebuttonPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  return app;
}

/** Walk the beneficiary sign-in: authorize, pick a patient, exchange the code with PKCE. */
async function signIn(
  app: Hono,
  patient = "syn-patient-002",
  scope: string | undefined = "patient/Patient.read patient/Coverage.read patient/ExplanationOfBenefit.read profile",
): Promise<any> {
  const verifier = randomBytes(32).toString("base64url");
  const auth = await app.request(
    `${origin}/v2/o/authorize/?${new URLSearchParams({
      response_type: "code",
      client_id: "bb-app",
      redirect_uri: redirect,
      ...(scope ? { scope } : {}),
      state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })}`,
  );
  const html = await auth.text();
  const request = html.match(/name="request" value="([^"]*)"/)![1];
  expect(html).not.toContain('name="practitioner"');
  const picked = await app.request(`${origin}/v2/o/authorize/select`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, patient }),
  });
  const code = new URL(picked.headers.get("Location")!).searchParams.get("code")!;
  const token = (await app.request(`${origin}/v2/o/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: "bb-app",
      code_verifier: verifier,
    }),
  })) as JsonResponse;
  return token.json();
}

const get = (app: Hono, path: string, token?: string) =>
  app.request(
    `${base}${path}`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  ) as Promise<JsonResponse>;

describe("Blue Button 2.0", () => {
  it("signs in a beneficiary and returns patient context and userinfo", async () => {
    const app = startService();
    const token = await signIn(app);
    expect(token.patient).toBe("syn-patient-002");
    const info = (await app.request(`${origin}/v2/connect/userinfo`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    })) as JsonResponse;
    expect(await info.json()).toMatchObject({ sub: "syn-patient-002", patient: "syn-patient-002" });
  });

  it("grants the standard beneficiary scopes when the authorize request sends none", async () => {
    const app = startService();
    const token = await signIn(app, "syn-patient-002", undefined);
    expect(token.scope.split(" ")).toEqual(
      expect.arrayContaining(["patient/Patient.read", "patient/Coverage.read", "patient/ExplanationOfBenefit.read"]),
    );
    expect((await get(app, "/ExplanationOfBenefit?patient=syn-patient-002", token.access_token)).status).toBe(200);
  });

  it("requires a token, is read-only, and serves only Patient, Coverage, and ExplanationOfBenefit", async () => {
    const app = startService();
    expect((await get(app, "/metadata")).status).toBe(200);
    expect((await get(app, "/Patient/syn-patient-002")).status).toBe(401);
    const { access_token } = await signIn(app);
    expect((await get(app, "/Observation", access_token)).status).toBe(404);
    const write = await app.request(`${base}/Patient/syn-patient-002`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(write.status).toBe(405);
  });

  it("returns the beneficiary's coverage and claims, and nobody else's", async () => {
    const app = startService();
    const { access_token } = await signIn(app);
    const patient = await (await get(app, "/Patient/syn-patient-002", access_token)).json();
    const mbi = patient.identifier.find((i: { system: string }) => i.system === "http://hl7.org/fhir/sid/us-mbi");
    expect(mbi.value).toBe(syntheticMbi(2));
    expect(mbi.value).toContain("S");
    const coverage = await (await get(app, "/Coverage?beneficiary=syn-patient-002", access_token)).json();
    expect(coverage.entry.map((e: any) => e.resource.class[1].value).sort()).toEqual(["Part A", "Part B", "Part D"]);
    const eobs = await (await get(app, "/ExplanationOfBenefit?patient=syn-patient-002", access_token)).json();
    expect(eobs.total).toBeGreaterThan(0);
    const carrier = await (
      await get(
        app,
        "/ExplanationOfBenefit?patient=syn-patient-002&type=https://bluebutton.cms.gov/resources/codesystem/eob-type|CARRIER",
        access_token,
      )
    ).json();
    for (const e of carrier.entry) expect(e.resource.type.coding[0].code).toBe("CARRIER");
    const other = await get(app, "/Patient/syn-patient-001", access_token);
    expect(other.status).toBe(404);
  });

  it("accepts the paths CMS's SDK uses, with and without trailing slashes", async () => {
    const app = startService();
    const authorize = await app.request(`${origin}/v2/o/authorize?response_type=code&client_id=bb-app`);
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get("Location")).toBe("/v2/o/authorize/?response_type=code&client_id=bb-app");
    const { access_token } = await signIn(app);
    const eobs = await (await get(app, "/ExplanationOfBenefit/?patient=syn-patient-002", access_token)).json();
    expect(eobs.total).toBeGreaterThan(0);
    expect((await get(app, "/Coverage/", access_token)).status).toBe(200);
    expect((await get(app, "/Coverage/")).status).toBe(401);
  });
});
