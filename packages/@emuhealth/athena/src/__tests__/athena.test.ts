import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { athenaPlugin, seedFromConfig, type AthenaSeedConfig } from "../index.js";

const origin = "http://localhost:4110";

async function startService(config?: AthenaSeedConfig) {
  const app = new Hono();
  const store = new Store();
  athenaPlugin.register(app as never, store, new WebhookDispatcher(), origin);
  athenaPlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  const tokenRes = await app.request(`${origin}/oauth2/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from("client:secret").toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=athena/service/Athenanet.MDP.*",
  });
  const token = ((await tokenRes.json()) as { access_token: string }).access_token;
  const call = async (path: string, init: { method?: string; form?: Record<string, string>; auth?: boolean } = {}) => {
    const res = await app.request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.auth === false ? {} : { Authorization: `Bearer ${token}` }),
        ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return call;
}

describe("athenahealth proprietary API", () => {
  it("needs a client credentials token and a known practice", async () => {
    const call = await startService();
    expect((await call("/v1/195900/departments", { auth: false })).status).toBe(401);
    expect((await call("/v1/1/departments")).status).toBe(404);
    const departments = await call("/v1/195900/departments");
    expect(departments.body).toMatchObject({ totalcount: 1, departments: [{ departmentid: "1" }] });
  });

  it("finds, reads, and creates patients with athenahealth date formats", async () => {
    const call = await startService();
    const one = (await call("/v1/195900/patients/1")).body[0];
    expect(one.patientid).toBe("1");
    expect(one.dob).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const found = await call(`/v1/195900/patients?lastname=${one.lastname}&dob=${encodeURIComponent(one.dob)}`);
    expect(found.body.patients.map((p: any) => p.patientid)).toContain("1");
    expect((await call("/v1/195900/patients")).status).toBe(400);
    const created = await call("/v1/195900/patients", {
      method: "POST",
      form: { firstname: "Jamie", lastname: "Example", dob: "01/02/1990", departmentid: "1", sex: "F" },
    });
    const id = created.body[0].patientid;
    expect((await call(`/v1/195900/patients/${id}`)).body[0]).toMatchObject({ firstname: "Jamie", dob: "01/02/1990" });
    expect((await call("/v1/195900/patients/999")).status).toBe(404);
  });

  it("serves chart problems, allergies, medications, and vitals from the synthetic records", async () => {
    const call = await startService();
    expect((await call("/v1/195900/chart/2/problems")).status).toBe(400);
    const problems = await call("/v1/195900/chart/2/problems?departmentid=1");
    expect(problems.body.problems.length).toBeGreaterThan(0);
    expect(problems.body.problems[0].codeset).toBe("ICD10");
    const vitals = await call("/v1/195900/chart/1/vitals?departmentid=1");
    expect(vitals.body.vitals.map((v: any) => v.key)).toContain("Heart rate");
    expect((await call("/v1/195900/chart/2/medications?departmentid=1")).status).toBe(200);
    expect((await call("/v1/195900/chart/2/allergies?departmentid=1")).status).toBe(200);
  });

  it("books and cancels open appointments", async () => {
    const call = await startService({ scheduling: { startDate: "2030-01-07", days: 1 } });
    const open = await call(
      "/v1/195900/appointments/open?departmentid=1&startdate=01/07/2030&enddate=01/07/2030&limit=2",
    );
    expect(open.body.appointments).toHaveLength(2);
    expect(open.body.next).toContain("offset=2");
    const slot = open.body.appointments[0];
    const booked = await call(`/v1/195900/appointments/${slot.appointmentid}`, {
      method: "PUT",
      form: { patientid: "1", appointmenttypeid: "2" },
    });
    expect(booked.body[0]).toMatchObject({ appointmentstatus: "f", patientid: "1" });
    expect(
      (await call(`/v1/195900/appointments/${slot.appointmentid}`, { method: "PUT", form: { patientid: "2" } })).status,
    ).toBe(409);
    const mine = await call("/v1/195900/appointments/booked?startdate=01/01/2030&enddate=12/31/2030&patientid=1");
    expect(mine.body.appointments.map((a: any) => a.appointmentid)).toEqual([slot.appointmentid]);
    const cancelled = await call(`/v1/195900/appointments/${slot.appointmentid}/cancel`, {
      method: "PUT",
      form: { patientid: "1", cancellationreason: "Synthetic reason" },
    });
    expect(cancelled.body.status).toBe("x");
  });
});

describe("athenahealth FHIR R4", () => {
  it("requires ah-practice on searches", async () => {
    const call = await startService();
    expect((await call("/fhir/r4/Patient?family=Cohen")).status).toBe(400);
    const ok = await call(`/fhir/r4/Patient?ah-practice=${encodeURIComponent("Organization/a-1.Practice-195900")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.resourceType).toBe("Bundle");
    expect((await call("/fhir/r4/Patient/syn-patient-001")).status).toBe(200);
  });
});
