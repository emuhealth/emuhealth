import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { memberId, payerPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4128";

function start() {
  const app = new Hono();
  const store = new Store();
  payerPlugin.register(app as never, store, new WebhookDispatcher(), base);
  payerPlugin.seed?.(store, base);
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`${base}${path}`, init);
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  };
  return { app, store, req };
}

async function systemToken(req: ReturnType<typeof start>["req"]) {
  const res = await req("/fhir/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "synthetic-new-payer",
      client_secret: "synthetic-new-payer-secret",
      scope: "system/*.read",
    }),
  });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

const match = (patient: any, subscriberId: string, consent = "active") => ({
  resourceType: "Parameters",
  parameter: [
    { name: "MemberPatient", resource: { resourceType: "Patient", name: patient.name, birthDate: patient.birthDate } },
    { name: "CoverageToMatch", resource: { resourceType: "Coverage", status: "active", subscriberId } },
    { name: "Consent", resource: { resourceType: "Consent", status: consent } },
  ],
});

describe("payer emulator", () => {
  it("requires a token for member data and serves CARIN data to a system token", async () => {
    const { req } = start();
    expect((await req("/fhir/Patient")).status).toBe(401);
    expect((await req("/fhir/metadata")).status).toBe(200);
    const token = await systemToken(req);
    const auth = { Authorization: `Bearer ${token}` };
    const eobs = await req("/fhir/ExplanationOfBenefit?patient=syn-patient-001", { headers: auth });
    expect(eobs.body.total).toBeGreaterThan(0);
    const eob = eobs.body.entry[0].resource;
    expect(eob.meta.profile[0]).toContain("C4BB-ExplanationOfBenefit-Professional-NonClinician");
    expect(eob.insurance[0].coverage.reference).toBe("Coverage/coverage-syn-patient-001");
    expect(eob.item[0].adjudication.length).toBeGreaterThan(2);
    const coverage = await req("/fhir/Coverage/coverage-syn-patient-001", { headers: auth });
    expect(coverage.body.subscriberId).toBe(memberId(1));
    // PDex clinical data rides along with the claims.
    expect((await req("/fhir/Observation?patient=syn-patient-001", { headers: auth })).body.total).toBeGreaterThan(0);
    expect((await req("/fhir/Condition", { headers: auth })).body.total).toBeGreaterThan(0);
  });

  it("matches a member for payer-to-payer exchange", async () => {
    const { req } = start();
    const auth = { Authorization: `Bearer ${await systemToken(req)}`, "Content-Type": "application/fhir+json" };
    const patient = (await req("/fhir/Patient/syn-patient-002", { headers: auth })).body;
    const ok = await req("/fhir/Patient/$member-match", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(match(patient, memberId(2))),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.parameter[0].valueIdentifier).toMatchObject({
      value: memberId(2),
      type: { coding: [{ code: "MB" }] },
    });
    expect(ok.body.parameter[1].valueReference.reference).toBe("Patient/syn-patient-002");

    const wrong = await req("/fhir/Patient/$member-match", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(match(patient, memberId(3))),
    });
    expect(wrong.status).toBe(422);
    const revoked = await req("/fhir/Patient/$member-match", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(match(patient, memberId(2), "inactive")),
    });
    expect(revoked.status).toBe(422);
    expect((await req("/fhir/Patient/$member-match", { method: "POST", body: "{}" })).status).toBe(401);
    const everything = await req("/fhir/Patient/syn-patient-002/$everything", { headers: auth });
    expect(everything.body.entry.some((e: any) => e.resource.resourceType === "ExplanationOfBenefit")).toBe(true);
  });

  it("serves a public, read-only Plan-Net directory", async () => {
    const { req } = start();
    const roles = await req(
      "/directory/PractitionerRole?network=Organization/network-hmo&_include=PractitionerRole:practitioner",
    );
    expect(roles.status).toBe(200);
    expect(roles.body.total).toBe(8);
    expect(roles.body.entry.some((e: any) => e.resource.resourceType === "Practitioner")).toBe(true);
    const plans = await req("/directory/InsurancePlan?administered-by=Organization/syn-payer");
    expect(plans.body.total).toBe(2);
    const endpoint = await req("/directory/Endpoint/endpoint-patient-access");
    expect(endpoint.body.address).toBe(`${base}/fhir`);
    expect((await req("/directory/Organization?type=ntwk")).body.total).toBe(2);
    expect((await req("/directory/Practitioner", { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("follows generator options and can leave the directory empty", async () => {
    const { store, req } = start();
    seedFromConfig(store, base, { generate: { patients: 2 }, directory: false });
    const auth = { Authorization: `Bearer ${await systemToken(req)}` };
    expect((await req("/fhir/Coverage", { headers: auth })).body.total).toBe(2);
    expect((await req("/directory/Practitioner")).body.total).toBe(0);
  });
});
