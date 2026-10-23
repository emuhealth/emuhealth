import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { redoxPlugin, seedFromConfig, type RedoxSeedConfig } from "../index.js";

const origin = "http://localhost:4113";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function startService(config?: RedoxSeedConfig) {
  const app = new Hono();
  const store = new Store();
  redoxPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  redoxPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const auth = (await (
    await app.request(`${origin}/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key", secret: "synthetic-secret" }),
    })
  )
    .json()
    .catch(() => ({ accessToken: "", refreshToken: "" }))) as { accessToken: string; refreshToken: string };
  const send = async (message: unknown, token = auth.accessToken) => {
    const res = await app.request(`${origin}/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { app, auth, send };
}

const meta = (DataModel: string, EventType: string) => ({ Meta: { DataModel, EventType, Test: true } });
const byMrn = { Identifiers: [{ ID: "SYN-000002", IDType: "MR" }] };

async function receiver() {
  const received: Array<{ headers: IncomingHttpHeaders; body: string; url: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, url: req.url ?? "" });
      const challenge = new URL(req.url ?? "", "http://x").searchParams.get("challenge");
      res.end(challenge ?? "ok");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/redox`, received };
}

describe("Redox", () => {
  it("authenticates with API keys and refresh tokens, and rejects missing tokens", async () => {
    const { app, auth, send } = await startService();
    expect(auth.accessToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await send(meta("PatientSearch", "Query"), "nope")).status).toBe(401);
    const refreshed = await app.request(`${origin}/auth/refreshToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key", refreshToken: auth.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const restricted = await startService({ sources: [{ apiKey: "k", secret: "s" }] });
    const denied = await restricted.app.request(`${origin}/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "k", secret: "wrong" }),
    });
    expect(denied.status).toBe(401);
  });

  it("answers PatientSearch and ClinicalSummary queries from the synthetic records", async () => {
    const { send } = await startService();
    const search = await send({ ...meta("PatientSearch", "Query"), Patient: byMrn });
    expect(search.status).toBe(200);
    expect(search.body.Patient.Identifiers).toContainEqual({ ID: "syn-patient-002", IDType: "EHRID" });
    expect(search.body.Meta.Errors).toEqual([]);
    const summary = await send({ ...meta("ClinicalSummary", "PatientQuery"), Patient: byMrn });
    expect(summary.body.Header.Patient.Demographics.LastName).toBeTruthy();
    expect(summary.body.Problems.length).toBeGreaterThan(0);
    expect(summary.body.Problems[0].CodeSystemName).toBe("ICD-10");
    const unknown = await send({
      ...meta("ClinicalSummary", "PatientQuery"),
      Patient: { Identifiers: [{ ID: "nope", IDType: "MR" }] },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.Meta.Errors[0].Text).toContain("No patient");
  });

  it("creates patients and schedules visits", async () => {
    const { send } = await startService();
    const created = await send({
      ...meta("PatientAdmin", "NewPatient"),
      Patient: {
        Identifiers: [{ ID: "MY-1", IDType: "MR" }],
        Demographics: { FirstName: "Jamie", LastName: "Example", DOB: "1990-01-02", Sex: "Female" },
      },
    });
    expect(created.status).toBe(200);
    const found = await send({
      ...meta("PatientSearch", "Query"),
      Patient: { Demographics: { FirstName: "Jamie", LastName: "Example" } },
    });
    expect(found.body.Patient.Demographics.DOB).toBe("1990-01-02");
    const visit = { VisitNumber: "V-1", VisitDateTime: "2030-01-07T09:00:00Z", Duration: 30 };
    expect((await send({ ...meta("Scheduling", "New"), Patient: byMrn, Visit: visit })).status).toBe(200);
    expect((await send({ ...meta("Scheduling", "New"), Patient: byMrn, Visit: visit })).status).toBe(400);
    expect((await send({ ...meta("Scheduling", "Cancel"), Patient: byMrn, Visit: visit })).status).toBe(200);
    expect((await send(meta("Unknown", "Thing"))).body.Meta.Errors[0].Text).toContain("does not support");
  });

  it("delivers EHR events to destinations with the verification token, and runs the challenge handshake", async () => {
    const { url, received } = await receiver();
    const { app } = await startService({
      destinations: [{ url, verificationToken: "synthetic-token", dataModels: ["Results"] }],
    });
    const sent = await app.request(`${origin}/ehr/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ DataModel: "Results", EventType: "New", patientId: "syn-patient-002" }),
    });
    expect(sent.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].headers["verification-token"]).toBe("synthetic-token");
    expect(JSON.parse(received[0].body).Meta).toMatchObject({ DataModel: "Results", EventType: "New" });
    await app.request(`${origin}/ehr/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ DataModel: "PatientAdmin", EventType: "NewPatient" }),
    });
    expect(received).toHaveLength(1);
    const verify = await app.request(`${origin}/ehr/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, verificationToken: "synthetic-token" }),
    });
    expect(((await verify.json()) as { verified: boolean }).verified).toBe(true);
  });
});
