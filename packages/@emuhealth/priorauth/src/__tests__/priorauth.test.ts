import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { HCPCS, priorauthPlugin, REVIEW_DECISION } from "../index.js";

const base = "http://localhost:4129";

function start() {
  const app = new Hono();
  const store = new Store();
  priorauthPlugin.register(app as never, store, new WebhookDispatcher(), base);
  priorauthPlugin.seed?.(store, base);
  return async (path: string, body?: unknown) => {
    const res = await app.request(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
}

const deviceRequest = (code: string) => ({
  resourceType: "DeviceRequest",
  id: `order-${code}`,
  status: "draft",
  intent: "order",
  codeCodeableConcept: { coding: [{ system: HCPCS, code }] },
  subject: { reference: "Patient/syn-patient-001" },
});

const pasBundle = (code: string, value: string) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      fullUrl: "urn:uuid:claim",
      resource: {
        resourceType: "Claim",
        identifier: [{ system: "urn:example:provider:pa", value }],
        status: "active",
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
        use: "preauthorization",
        patient: { reference: "urn:uuid:patient" },
        created: "2026-02-01",
        insurer: { reference: "urn:uuid:insurer" },
        provider: { reference: "urn:uuid:provider" },
        priority: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/processpriority", code: "normal" }] },
        insurance: [{ sequence: 1, focal: true, coverage: { reference: "urn:uuid:coverage" } }],
        item: [{ sequence: 1, productOrService: { coding: [{ system: HCPCS, code }] } }],
      },
    },
    { fullUrl: "urn:uuid:patient", resource: { resourceType: "Patient", name: [{ family: "Example" }] } },
  ],
});

describe("prior authorization emulator", () => {
  it("answers CRD order-sign with coverage information", async () => {
    const req = start();
    const discovery = await req("/cds-services");
    expect(discovery.body.services.map((s: any) => s.hook)).toEqual(["order-sign", "order-select"]);
    const res = await req("/cds-services/coverage-requirements-order-sign", {
      hook: "order-sign",
      hookInstance: "d1577c69-dfbe-44ad-ba6d-3e05e953b2ea",
      context: {
        userId: "Practitioner/syn-practitioner-1",
        patientId: "syn-patient-001",
        draftOrders: {
          resourceType: "Bundle",
          entry: [{ resource: deviceRequest("E0601") }, { resource: deviceRequest("K0001") }],
        },
      },
      prefetch: {
        coverage: { resourceType: "Bundle", entry: [{ resource: { resourceType: "Coverage", id: "cov-1" } }] },
      },
    });
    expect(res.status).toBe(200);
    const info = (i: number) =>
      Object.fromEntries(
        res.body.systemActions[i].resource.extension[0].extension.map((e: any) => [e.url, Object.values(e)[1]]),
      );
    expect(info(0)).toMatchObject({ "pa-needed": "auth-needed", "doc-needed": "clinical", covered: "covered" });
    expect(info(0).questionnaire).toBe(`${base}/fhir/Questionnaire/home-cpap`);
    expect(info(1)["pa-needed"]).toBe("no-auth");
    expect(res.body.cards[0].links[0].url).toContain("home-cpap");

    const noCoverage = await req("/cds-services/coverage-requirements-order-select", {
      hook: "order-select",
      hookInstance: "x",
      context: { draftOrders: { resourceType: "Bundle", entry: [] } },
    });
    expect(noCoverage.body.cards[0].indicator).toBe("warning");
  });

  it("returns the DTR questionnaire package for an order", async () => {
    const req = start();
    const res = await req("/fhir/Questionnaire/$questionnaire-package", {
      resourceType: "Parameters",
      parameter: [
        { name: "coverage", resource: { resourceType: "Coverage", id: "cov-1" } },
        { name: "order", resource: deviceRequest("E1390") },
      ],
    });
    expect(res.body.parameter[0].resource.entry[0].resource.id).toBe("home-oxygen");
    expect((await req("/fhir/Questionnaire/$questionnaire-package", { resourceType: "Parameters" })).status).toBe(400);
  });

  it("decides PAS requests, pending until an inquiry", async () => {
    const req = start();
    const pended = await req("/fhir/Claim/$submit", pasBundle("E0601", "PA-1"));
    const first = pended.body.entry[0].resource;
    expect(first).toMatchObject({ resourceType: "ClaimResponse", outcome: "queued", use: "preauthorization" });
    expect(first.item[0].extension[0]).toEqual({ url: REVIEW_DECISION, valueCode: "pended" });
    const inquiry = await req("/fhir/Claim/$inquire", pasBundle("E0601", "PA-1"));
    expect(inquiry.body.entry[0].resource).toMatchObject({
      outcome: "complete",
      preAuthRef: expect.stringMatching(/^SYNPA-/),
    });

    const denied = await req("/fhir/Claim/$submit", pasBundle("E0260", "PA-2"));
    expect(denied.body.entry[0].resource.disposition).toBe("Denied");
    const approved = await req("/fhir/Claim/$submit", pasBundle("K0001", "PA-3"));
    expect(approved.body.entry[0].resource.outcome).toBe("complete");
    expect((await req("/fhir/Claim/$inquire", pasBundle("K0001", "PA-404"))).status).toBe(404);
    expect((await req("/fhir/ClaimResponse?_summary=count")).body.total).toBe(3);
  });
});
