import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, type FhirResource, type FhirSeedConfig } from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };
const ASYNC = { Prefer: "respond-async", Accept: "application/fhir+json" };

// Synthetic records only.
const resources: FhirResource[] = [
  { resourceType: "Organization", id: "org1", name: "Example Clinic" },
  { resourceType: "Patient", id: "p1", managingOrganization: { reference: "Organization/org1" } },
  { resourceType: "Patient", id: "p2" },
  { resourceType: "Patient", id: "p3" },
  { resourceType: "Observation", id: "o1", status: "final", code: { text: "a" }, subject: { reference: "Patient/p1" } },
  { resourceType: "Observation", id: "o2", status: "final", code: { text: "b" }, subject: { reference: "Patient/p2" } },
  { resourceType: "Condition", id: "c3", code: { text: "c" }, subject: { reference: "Patient/p3" } },
  {
    resourceType: "Group",
    id: "g1",
    type: "person",
    actual: true,
    member: [{ entity: { reference: "Patient/p1" } }, { entity: { reference: "Patient/p2" } }],
  },
];

function createApp(smart?: FhirSeedConfig["smart"]) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { generate: false, terminology: false, resources, ...(smart ? { smart } : {}) });
  return app;
}

function get(app: Hono, url: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return app.request(url.startsWith("http") ? url : `${base}${url}`, { headers });
}

/** Kick off, read the manifest, and download every file. Returns ids per type. */
async function runExport(app: Hono, path: string, headers: Record<string, string> = {}) {
  const kick = await get(app, path, { ...ASYNC, ...headers });
  expect(kick.status).toBe(202);
  const status = kick.headers.get("Content-Location")!;
  expect(status).toMatch(/^http:\/\/localhost:4100\/\$export-status\//);
  const manifestRes = await get(app, status, headers);
  expect(manifestRes.status).toBe(200);
  const manifest = await manifestRes.json();
  const files: Record<string, string[]> = {};
  for (const output of manifest.output) {
    const file = await get(app, output.url, headers);
    expect(file.headers.get("Content-Type")).toContain("application/fhir+ndjson");
    const lines = (await file.text()).trim().split("\n");
    expect(lines).toHaveLength(output.count);
    files[output.type] = lines.map((l) => (JSON.parse(l) as FhirResource).id!);
  }
  return { manifest, files, status };
}

describe("Bulk Data $export", () => {
  it("exports every type at the system level as NDJSON", async () => {
    const app = createApp();
    const { manifest, files } = await runExport(app, "/$export");
    expect(manifest).toMatchObject({ request: `${base}/$export`, requiresAccessToken: false, error: [] });
    expect(manifest.output.map((o: { type: string }) => o.type)).toEqual([
      "Condition",
      "Group",
      "Observation",
      "Organization",
      "Patient",
    ]);
    expect(files.Patient).toEqual(["p1", "p2", "p3"]);
    expect(files.Observation).toEqual(["o1", "o2"]);
  });

  it("filters by _type and _since", async () => {
    const app = createApp();
    const typed = await runExport(app, "/$export?_type=Patient,Observation&_outputFormat=application/fhir%2Bndjson");
    expect(Object.keys(typed.files).sort()).toEqual(["Observation", "Patient"]);
    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    expect((await runExport(app, `/$export?_since=${future}`)).manifest.output).toEqual([]);
  });

  it("limits Patient and Group exports to patient compartments", async () => {
    const app = createApp();
    const patient = await runExport(app, "/Patient/$export");
    expect(patient.files.Patient).toEqual(["p1", "p2", "p3"]);
    expect(patient.files.Organization).toBeUndefined();
    // A Group with patient members is in those patients' compartment (Patient CompartmentDefinition, member).
    expect(patient.files.Group).toEqual(["g1"]);
    const group = await runExport(app, "/Group/g1/$export");
    expect(group.files.Patient).toEqual(["p1", "p2"]);
    expect(group.files.Observation).toEqual(["o1", "o2"]);
    expect(group.files.Condition).toBeUndefined();
    expect((await get(app, "/Group/missing/$export", ASYNC)).status).toBe(404);
  });

  it("validates the kick-off request", async () => {
    const app = createApp();
    const expect400 = async (path: string, headers = ASYNC) => {
      const res = await get(app, path, headers);
      expect(res.status).toBe(400);
      expect((await res.json()).resourceType).toBe("OperationOutcome");
    };
    await expect400("/$export", { Prefer: "", Accept: "application/fhir+json" });
    await expect400("/$export?_outputFormat=text/csv");
    await expect400("/$export?_type=Spaceship");
    await expect400("/$export?_since=soon");
    await expect400("/$export?_typeFilter=Observation%3Fstatus%3Dfinal");
  });

  it("deletes jobs and 404s unknown ones", async () => {
    const app = createApp();
    const { status } = await runExport(app, "/$export");
    const del = await app.request(status, { method: "DELETE" });
    expect(del.status).toBe(202);
    expect((await get(app, status)).status).toBe(404);
    expect((await get(app, "/$export-status/unknown")).status).toBe(404);
  });

  it("is advertised in the CapabilityStatement", async () => {
    const cs = await (await get(createApp(), "/metadata")).json();
    expect(cs.instantiates).toContain("http://hl7.org/fhir/uv/bulkdata/CapabilityStatement/bulk-data");
    expect(cs.rest[0].operation).toContainEqual({
      name: "export",
      definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export",
    });
    const group = cs.rest[0].resource.find((r: { type: string }) => r.type === "Group");
    expect(group.operation[0].name).toBe("export");
  });
});

describe("Bulk Data $export with SMART tokens", () => {
  async function backendToken(
    app: Hono,
    key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
    clientId: string,
    scope: string,
  ) {
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS384", kid: clientId })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(`${base}/auth/token`)
      .setExpirationTime("4m")
      .setJti(randomUUID())
      .sign(key);
    const res: JsonResponse = await app.request(`${base}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString(),
    });
    return (await res.json()).access_token as string;
  }

  async function setup() {
    const a = await generateKeyPair("RS384", { extractable: true });
    const b = await generateKeyPair("RS384", { extractable: true });
    const app = createApp({
      clients: [
        {
          client_id: "exporter",
          jwks: { keys: [{ ...(await exportJWK(a.publicKey)), kid: "exporter", alg: "RS384" }] },
        },
        { client_id: "other", jwks: { keys: [{ ...(await exportJWK(b.publicKey)), kid: "other", alg: "RS384" }] } },
      ],
    });
    return { app, a, b };
  }

  it("requires the same client's token to read the manifest and files", async () => {
    const { app, a, b } = await setup();
    const token = await backendToken(app, a.privateKey, "exporter", "system/*.rs");
    const { manifest, status, files } = await runExport(app, "/$export", { Authorization: `Bearer ${token}` });
    expect(manifest.requiresAccessToken).toBe(true);
    expect(files.Patient).toEqual(["p1", "p2", "p3"]);
    expect((await get(app, status)).status).toBe(401);
    expect((await get(app, manifest.output[0].url)).status).toBe(401);
    const otherToken = await backendToken(app, b.privateKey, "other", "system/*.rs");
    expect((await get(app, status, { Authorization: `Bearer ${otherToken}` })).status).toBe(403);
  });

  it("exports only the types the token can read", async () => {
    const { app, a } = await setup();
    const token = await backendToken(app, a.privateKey, "exporter", "system/Patient.rs");
    const auth = { Authorization: `Bearer ${token}` };
    expect(Object.keys((await runExport(app, "/$export", auth)).files)).toEqual(["Patient"]);
    expect((await get(app, "/$export?_type=Observation", { ...ASYNC, ...auth })).status).toBe(403);
  });

  it("limits a patient token to its own records", async () => {
    const app = createApp({ requirePkce: false });
    const launch = await app.request(
      `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}&patient=p1`,
    );
    const launchId = new URL(launch.headers.get("Location")!).searchParams.get("launch")!;
    const auth = await app.request(
      `${base}/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "app", redirect_uri: "http://localhost:3000/cb", aud: base, launch: launchId, scope: "launch patient/*.rs" })}`,
    );
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes: JsonResponse = await app.request(`${base}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/cb",
        client_id: "app",
      }).toString(),
    });
    const token = (await tokenRes.json()).access_token;
    const { files } = await runExport(app, "/Patient/$export", { Authorization: `Bearer ${token}` });
    expect(files).toEqual({ Group: ["g1"], Observation: ["o1"], Patient: ["p1"] });
  });
});
