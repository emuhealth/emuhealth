import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, registerFhirRoutes, resourceSummary, seedFromConfig, type FhirSeedConfig } from "../index.js";

const base = "http://localhost:4100";

function createApp(config: FhirSeedConfig = {}) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  seedFromConfig(store, base, config);
  return app;
}

const page = async (app: Hono, query: string) => {
  const res = await app.request(`${base}/_inspector${query}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
  return res.text();
};

describe("FHIR inspector", () => {
  it("lists resource types with counts using the shared inspector layout", async () => {
    const html = await page(createApp(), "");
    expect(html).toContain("inspector-tabs");
    expect(html).toContain("FHIR Emulator");
    expect(html).toMatch(/Resources \(\d+\)/);
    expect(html).toContain("?tab=resources&amp;type=Patient");
    expect(html).toContain("Recent changes");
  });

  it("lists resources of a type and shows a resource with its versions", async () => {
    const app = createApp();
    const list = await page(app, "?tab=resources&type=Patient");
    expect(list).toContain("Patient (5)");
    expect(list).toContain("syn-patient-001");
    await app.request(`${base}/Patient/syn-patient-001`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "replace", path: "/active", value: false }]),
    });
    const detail = await page(app, "?tab=resources&type=Patient&id=syn-patient-001");
    expect(detail).toContain("Current version");
    expect(detail).toContain("History (2)");
    expect(detail).toContain("Version 2 (PATCH");
    expect(detail).toContain(`${base}/Patient/syn-patient-001`);
  });

  it("escapes resource content", async () => {
    const app = createApp({
      generate: false,
      resources: [{ resourceType: "Patient", id: "x", name: [{ text: "<script>alert(1)</script>" }] }],
    });
    const list = await page(app, "?tab=resources&type=Patient");
    expect(list).not.toContain("<script>alert(1)</script>");
    expect(list).toContain("&lt;script&gt;");
  });

  it("shows recent changes, SMART clients and tokens, and exports", async () => {
    const app = createApp({
      smart: { requirePkce: false, clients: [{ client_id: "demo-app", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    // Generated records are written with update-as-create, so they show as PUT.
    const changes = await page(app, "?tab=changes");
    expect(changes).toContain("PUT");
    // Newest first and limited to 100, so the earliest generated records may not be listed.
    expect(changes).toContain("syn-");

    const auth = await app.request(
      `${base}/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "demo-app", redirect_uri: "http://localhost:3000/cb", aud: base, scope: "patient/*.rs" })}`,
    );
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
    const token = (await (
      await app.request(`${base}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/cb",
          client_id: "demo-app",
        }).toString(),
      })
    ).json()) as { access_token: string };
    const smart = await page(app, "?tab=smart");
    expect(smart).toContain("Registered clients (1)");
    expect(smart).toContain("demo-app");
    expect(smart).toContain("Live tokens (1)");
    expect(smart).toContain(`${token.access_token.slice(0, 8)}...`);
    expect(smart).not.toContain(token.access_token);

    await app.request(`${base}/$export?_type=Patient`, { headers: { Prefer: "respond-async" } });
    const exports = await page(app, "?tab=exports");
    expect(exports).toContain("Bulk Data exports (1)");
    expect(exports).toContain("Patient 5");
  });

  it("stays available when tokens are required, and can be turned off", async () => {
    const strict = createApp({ smart: { required: true } });
    expect((await strict.request(`${base}/Patient`)).status).toBe(401);
    expect((await strict.request(`${base}/_inspector`)).status).toBe(200);

    const vendor = new Hono();
    registerFhirRoutes(vendor, new Store(), { baseUrl: base, inspectorPath: false });
    expect((await vendor.request(`${base}/_inspector`)).status).toBe(404);
  });
});

describe("resourceSummary", () => {
  it("prefers names, then codes, then status", () => {
    expect(resourceSummary({ resourceType: "Patient", name: [{ given: ["Ana"], family: "Example" }] })).toBe(
      "Ana Example",
    );
    expect(resourceSummary({ resourceType: "Organization", name: "Example Clinic" })).toBe("Example Clinic");
    expect(resourceSummary({ resourceType: "Observation", code: { coding: [{ display: "Heart rate" }] } })).toBe(
      "Heart rate",
    );
    expect(resourceSummary({ resourceType: "Immunization", vaccineCode: { text: "Tdap" } })).toBe("Tdap");
    expect(resourceSummary({ resourceType: "Task", status: "requested" })).toBe("requested");
  });
});
