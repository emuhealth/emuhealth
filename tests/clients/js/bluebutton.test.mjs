// CMS's Blue Button Node SDK against the Blue Button emulator on the SDK's LOCAL environment (localhost:8000).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlueButton } from "cms-bluebutton-sdk";
import { signIn } from "./browser.mjs";

const CALLBACK = "http://localhost:3000/callback";

test("authorizes a beneficiary and reads claims with the SDK", async () => {
  const bb = new BlueButton({
    environment: "LOCAL",
    version: "2",
    clientId: "bb-sdk-app",
    clientSecret: "synthetic-bb-secret",
    callbackUrl: CALLBACK,
    retrySettings: { total: 0, backoffFactor: 1, statusForcelist: [] },
  });
  const authData = bb.generateAuthData();
  const callback = new URL(await signIn(bb.generateAuthorizeUrl(authData), CALLBACK));
  const token = await bb.getAuthorizationToken(
    authData,
    callback.searchParams.get("code") ?? undefined,
    callback.searchParams.get("state") ?? undefined,
  );
  assert.ok(token.accessToken);

  const eob = await bb.getExplanationOfBenefitData(token);
  assert.equal(eob.response?.status, 200);
  assert.equal(eob.response.data.resourceType, "Bundle");
  assert.ok(eob.response.data.entry.length > 0);
  assert.equal(eob.response.data.entry[0].resource.resourceType, "ExplanationOfBenefit");

  const patient = await bb.getPatientData(eob.token);
  assert.equal(patient.response?.data.entry[0].resource.resourceType, "Patient");
  const coverage = await bb.getCoverageData(patient.token);
  assert.ok(coverage.response?.data.entry.length >= 3);
  const profile = await bb.getProfileData(coverage.token);
  assert.match(profile.response?.data.patient ?? "", /^syn-patient-/);
});
