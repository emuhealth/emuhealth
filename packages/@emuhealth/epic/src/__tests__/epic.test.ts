import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { epicPlugin, seedFromConfig, EPIC_OUTCOME_SYSTEM, type EpicSeedConfig } from "../index.js";

const origin = "http://localhost:4101";
const base = `${origin}/api/FHIR/R4`;
const redirect = "http://localhost:3000/callback";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function startService(config?: EpicSeedConfig) {
  const app = new Hono();
  const store = new Store();
  epicPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  epicPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path.startsWith("http") ? path : `${base}${path}`, init) as Promise<JsonResponse>;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, request, post };
}

const findBody = (patient: string, startTime: string, endTime: string) => ({
  resourceType: "Parameters",
  parameter: [
    { name: "patient", valueReference: { reference: `Patient/${patient}` } },
    { name: "startTime", valueDateTime: startTime },
    { name: "endTime", valueDateTime: endTime },
  ],
});

describe("Epic URL shape", () => {
  it("serves the FHIR API under /api/FHIR/R4 with Epic's OAuth paths", async () => {
    const { request } = startService();
    const metadata = await request("/metadata");
    expect(metadata.status).toBe(200);
    const cs = await metadata.json();
    expect(cs.software.name).toBe("emuhealth Epic emulator");
    expect((await request("/Patient/syn-patient-001")).status).toBe(200);
    const smart = await (await request("/.well-known/smart-configuration")).json();
    expect(smart).toMatchObject({
      issuer: base,
      authorization_endpoint: `${origin}/oauth2/authorize`,
      token_endpoint: `${origin}/oauth2/token`,
    });
    const outside = await request(`${origin}/Patient/syn-patient-001`);
    expect(outside.status).toBe(404);
    expect((await outside.json()).resourceType).toBe("OperationOutcome");
  });

  it("answers an empty search with Epic's informational OperationOutcome", async () => {
    const { request } = startService();
    const empty = await (await request("/Observation?patient=syn-patient-001&code=http://loinc.org|0000-0")).json();
    expect(empty.total).toBe(0);
    expect(empty.entry).toHaveLength(1);
    expect(empty.entry[0].search.mode).toBe("outcome");
    expect(empty.entry[0].resource.issue[0].details.coding[0]).toMatchObject({
      system: EPIC_OUTCOME_SYSTEM,
      code: "4101",
    });
    const found = await (await request("/Patient?_id=syn-patient-001")).json();
    expect(found.entry.every((e: { search: { mode: string } }) => e.search.mode === "match")).toBe(true);
  });

  it("adds __epic.dstu2.patient to token responses with a patient", async () => {
    const { app } = startService({ smart: { requirePkce: false } });
    const launch = await app.request(
      `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}&patient=syn-patient-002`,
    );
    const launchId = new URL(launch.headers.get("Location")!).searchParams.get("launch")!;
    const auth = await app.request(
      `${origin}/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "app",
        redirect_uri: redirect,
        aud: base,
        launch: launchId,
        scope: "launch patient/*.rs",
      })}`,
    );
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
    const token = await (
      (await app.request(`${origin}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: "app" }),
      })) as JsonResponse
    ).json();
    expect(token).toMatchObject({ patient: "syn-patient-002", "__epic.dstu2.patient": "syn-patient-002" });
  });
});

describe("Epic scheduling", () => {
  const scheduling = { startDate: "2030-01-07", days: 2 }; // a Monday

  it("seeds a Schedule per practitioner and weekday slots", async () => {
    const { request } = startService({ scheduling });
    expect((await (await request("/Schedule")).json()).total).toBe(2);
    // 14 half hour slots a day, 2 days, 2 practitioners.
    expect((await (await request("/Slot?_count=0&_summary=count")).json()).total).toBe(56);
  });

  it("finds proposed appointments in free slots and books one", async () => {
    const { post, request } = startService({ scheduling });
    const found = await post(
      "/Appointment/$find",
      findBody("syn-patient-001", "2030-01-07T09:00:00Z", "2030-01-07T10:00:00Z"),
    );
    expect(found.status).toBe(200);
    const bundle = await found.json();
    expect(bundle.total).toBe(4);
    const proposed = bundle.entry[0].resource;
    expect(proposed).toMatchObject({ resourceType: "Appointment", status: "proposed", start: "2030-01-07T09:00:00Z" });

    const booked = await post("/Appointment/$book", {
      resourceType: "Parameters",
      parameter: [
        { name: "appointment", resource: proposed },
        { name: "appointmentNote", valueString: "Synthetic follow-up" },
      ],
    });
    expect(booked.status).toBe(200);
    const appointment = await booked.json();
    expect(appointment).toMatchObject({ status: "booked", comment: "Synthetic follow-up" });
    expect((await request(`/Appointment/${appointment.id}`)).status).toBe(200);
    const slotId = proposed.slot[0].reference.split("/")[1];
    expect((await (await request(`/Slot/${slotId}`)).json()).status).toBe("busy");

    const again = await post("/Appointment/$book", {
      resourceType: "Parameters",
      parameter: [
        { name: "appointment", valueString: proposed.id },
        { name: "patient", valueReference: { reference: "Patient/syn-patient-002" } },
      ],
    });
    expect(again.status).toBe(409);
    const after = await (
      await post("/Appointment/$find", findBody("syn-patient-002", "2030-01-07T09:00:00Z", "2030-01-07T10:00:00Z"))
    ).json();
    expect(after.total).toBe(3);
  });

  it("rejects bad requests with OperationOutcomes", async () => {
    const { post } = startService({ scheduling });
    expect((await post("/Appointment/$find", { resourceType: "Patient" })).status).toBe(400);
    expect(
      (await post("/Appointment/$find", findBody("nobody", "2030-01-07T09:00:00Z", "2030-01-08T00:00:00Z"))).status,
    ).toBe(404);
    expect(() => startService({ scheduling: { days: 99 } })).toThrow("epic.scheduling.days");
  });
});
