import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, subscriptionDeliveries, subscriptionsIdle } from "../index.js";

const base = "http://localhost:4100";
const TOPIC = "http://example.org/SubscriptionTopic/encounter-in-progress";
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function receiver(status = 200) {
  const received: Array<{ headers: Record<string, unknown>; body: any }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(status).end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received };
}

function start(fhirVersion: string) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  seedFromConfig(store, base, { fhirVersion });
  const mime =
    fhirVersion === "R5" ? "application/fhir+json; fhirVersion=5.0" : "application/fhir+json; fhirVersion=4.3";
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`${base}${path}`, { ...init, headers: { "Content-Type": mime } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
  return { store, req, post };
}

const topic = (fhirVersion: string) => ({
  resourceType: "SubscriptionTopic",
  url: TOPIC,
  status: "active",
  ...(fhirVersion === "R5" ? {} : { title: "Encounter in progress" }),
  resourceTrigger: [
    {
      resource: "http://hl7.org/fhir/StructureDefinition/Encounter",
      supportedInteraction: ["create", "update"],
      queryCriteria: { current: "status=in-progress", resultForCreate: "test-passes", resultForDelete: "test-fails" },
    },
  ],
});

const encounter = (patient: string, status: string, fhirVersion: string) => ({
  resourceType: "Encounter",
  status,
  class: fhirVersion === "R5" ? [{ coding: [{ code: "AMB" }] }] : { code: "AMB" },
  subject: { reference: `Patient/${patient}` },
});

describe("FHIR Subscriptions", () => {
  it("handshakes, filters, and notifies on R5", async () => {
    const { store, req, post } = start("R5");
    const hook = await receiver();
    await post("/SubscriptionTopic", topic("R5"));
    const sub = await post("/Subscription", {
      resourceType: "Subscription",
      status: "requested",
      topic: TOPIC,
      channelType: { system: "http://terminology.hl7.org/CodeSystem/subscription-channel-type", code: "rest-hook" },
      endpoint: hook.url,
      content: "full-resource",
      parameter: [{ name: "Authorization", value: "Bearer synthetic-hook-token" }],
      filterBy: [{ resourceType: "Encounter", filterParameter: "patient", value: "Patient/syn-patient-001" }],
    });
    expect(sub.status).toBe(201);
    await subscriptionsIdle(store);
    expect(hook.received[0].body.entry[0].resource.type).toBe("handshake");
    expect((await req(`/Subscription/${sub.body.id}`)).body.status).toBe("active");

    await post("/Encounter", encounter("syn-patient-001", "in-progress", "R5"));
    await post("/Encounter", encounter("syn-patient-002", "in-progress", "R5"));
    await post("/Encounter", encounter("syn-patient-001", "completed", "R5"));
    await subscriptionsIdle(store);

    expect(hook.received).toHaveLength(2);
    const note = hook.received[1];
    expect(note.headers.authorization).toBe("Bearer synthetic-hook-token");
    expect(note.body.type).toBe("subscription-notification");
    const status = note.body.entry[0].resource;
    expect(status).toMatchObject({
      resourceType: "SubscriptionStatus",
      type: "event-notification",
      eventsSinceSubscriptionStart: 1,
    });
    expect(note.body.entry[1].resource.subject.reference).toBe("Patient/syn-patient-001");

    const statusBundle = await req(`/Subscription/${sub.body.id}/$status`);
    expect(statusBundle.body.entry[0].resource).toMatchObject({
      type: "query-status",
      eventsSinceSubscriptionStart: 1,
    });
    expect(subscriptionDeliveries(store).map((d) => d.type)).toEqual(["handshake", "event-notification"]);
  });

  it("sends nothing for a rolled back transaction and errors on a failed handshake", async () => {
    const { store, req, post } = start("R5");
    const hook = await receiver();
    await post("/SubscriptionTopic", topic("R5"));
    await post("/Subscription", {
      resourceType: "Subscription",
      status: "requested",
      topic: TOPIC,
      channelType: { code: "rest-hook" },
      endpoint: hook.url,
      content: "id-only",
    });
    await subscriptionsIdle(store);
    const failed = await post("/", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { resource: encounter("syn-patient-001", "in-progress", "R5"), request: { method: "POST", url: "Encounter" } },
        { request: { method: "PUT", url: "Patient/x" }, resource: { resourceType: "Patient", id: "y" } },
      ],
    });
    expect(failed.status).toBe(400);
    await subscriptionsIdle(store);
    expect(hook.received).toHaveLength(1);

    const refusing = await receiver(500);
    const sub = await post("/Subscription", {
      resourceType: "Subscription",
      status: "requested",
      topic: TOPIC,
      channelType: { code: "rest-hook" },
      endpoint: refusing.url,
    });
    await subscriptionsIdle(store);
    expect((await req(`/Subscription/${sub.body.id}`)).body.status).toBe("error");
  });

  it("supports the R4B backport Subscription shape", async () => {
    const { store, post } = start("R4B");
    const hook = await receiver();
    await post("/SubscriptionTopic", topic("R4B"));
    await post("/Subscription", {
      resourceType: "Subscription",
      status: "requested",
      reason: "Encounters for one patient",
      criteria: TOPIC,
      _criteria: {
        extension: [
          {
            url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
            valueString: "Encounter?patient=Patient/syn-patient-002",
          },
        ],
      },
      channel: {
        type: "rest-hook",
        endpoint: hook.url,
        payload: "application/fhir+json",
        _payload: {
          extension: [
            {
              url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
              valueCode: "id-only",
            },
          ],
        },
        header: ["X-Synthetic: yes"],
      },
    });
    await subscriptionsIdle(store);
    await post("/Encounter", encounter("syn-patient-002", "in-progress", "R4B"));
    await post("/Encounter", encounter("syn-patient-001", "in-progress", "R4B"));
    await subscriptionsIdle(store);
    expect(hook.received).toHaveLength(2);
    const note = hook.received[1];
    expect(note.headers["x-synthetic"]).toBe("yes");
    expect(note.body.entry[0].resource.eventsSinceSubscriptionStart).toBe("1");
    expect(note.body.entry[1].resource).toBeUndefined();
    expect(note.body.entry[1].fullUrl).toMatch(/\/Encounter\//);
  });
});
