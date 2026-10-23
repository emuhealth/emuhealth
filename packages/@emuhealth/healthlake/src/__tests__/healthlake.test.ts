import { describe, it, expect } from "vitest";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  DEFAULT_DATASTORE_ID,
  EXAMPLE_CREDENTIALS,
  healthlakePlugin,
  seedFromConfig,
  type HealthLakeSeedConfig,
} from "../index.js";

const origin = "http://localhost:4114";

function startService(config?: HealthLakeSeedConfig) {
  const app = new Hono();
  const store = new Store();
  healthlakePlugin.register(app as never, store, new WebhookDispatcher(), origin);
  healthlakePlugin.seed?.(store, origin);
  if (config) seedFromConfig(store, origin, config);
  return app;
}

/** Sign a request the way the AWS SDK does, then send it. */
async function signed(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  credentials = EXAMPLE_CREDENTIALS,
) {
  const url = new URL(`${origin}${path}`);
  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "healthlake",
    sha256: Hash.bind(null, "sha256"),
  });
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = await signer.sign({
    method,
    protocol: "http:",
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      host: url.host,
      ...headers,
      ...(payload ? { "content-type": headers["content-type"] ?? "application/json" } : {}),
    },
    body: payload,
  });
  const res = await app.request(url.toString(), {
    method,
    headers: request.headers as Record<string, string>,
    body: payload,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const control = (app: Hono, operation: string, input: unknown, credentials = EXAMPLE_CREDENTIALS) =>
  signed(
    app,
    "POST",
    "/",
    input,
    { "x-amz-target": `HealthLake.${operation}`, "content-type": "application/x-amz-json-1.0" },
    credentials,
  );

describe("HealthLake control plane", () => {
  it("verifies SigV4 and rejects bad or missing signatures", async () => {
    const app = startService();
    expect((await control(app, "ListFHIRDatastores", {})).status).toBe(200);
    const wrong = await control(
      app,
      "ListFHIRDatastores",
      {},
      { accessKeyId: EXAMPLE_CREDENTIALS.accessKeyId, secretAccessKey: "wrong" },
    );
    expect(wrong).toMatchObject({ status: 403, body: { __type: "InvalidSignatureException" } });
    const unknown = await control(
      app,
      "ListFHIRDatastores",
      {},
      { accessKeyId: "AKIAUNKNOWN000000000", secretAccessKey: "x" },
    );
    expect(unknown.body.__type).toBe("UnrecognizedClientException");
    const unsigned = await app.request(`${origin}/`, {
      method: "POST",
      headers: { "X-Amz-Target": "HealthLake.ListFHIRDatastores" },
      body: "{}",
    });
    expect(unsigned.status).toBe(403);
  });

  it("creates, describes, lists, and deletes datastores", async () => {
    const app = startService();
    const list = await control(app, "ListFHIRDatastores", {});
    expect(list.body.DatastorePropertiesList[0]).toMatchObject({
      DatastoreId: DEFAULT_DATASTORE_ID,
      DatastoreStatus: "ACTIVE",
      DatastoreTypeVersion: "R4",
    });
    const created = await control(app, "CreateFHIRDatastore", { DatastoreName: "mine", DatastoreTypeVersion: "R4" });
    expect(created.body.DatastoreId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.body.DatastoreEndpoint).toBe(`${origin}/datastore/${created.body.DatastoreId}/r4/`);
    const described = await control(app, "DescribeFHIRDatastore", { DatastoreId: created.body.DatastoreId });
    expect(described.body.DatastoreProperties.DatastoreName).toBe("mine");
    expect((await control(app, "CreateFHIRDatastore", { DatastoreTypeVersion: "STU3" })).body.__type).toBe(
      "ValidationException",
    );
    await control(app, "DeleteFHIRDatastore", { DatastoreId: created.body.DatastoreId });
    expect((await control(app, "DescribeFHIRDatastore", { DatastoreId: created.body.DatastoreId })).body.__type).toBe(
      "ResourceNotFoundException",
    );
    const job = await control(app, "StartFHIRExportJob", {
      DatastoreId: DEFAULT_DATASTORE_ID,
      DataAccessRoleArn: "arn:aws:iam::123456789012:role/synthetic",
      OutputDataConfig: { S3Configuration: { S3Uri: "s3://synthetic-bucket/export", KmsKeyId: "x" } },
    });
    const status = await control(app, "DescribeFHIRExportJob", {
      DatastoreId: DEFAULT_DATASTORE_ID,
      JobId: job.body.JobId,
    });
    expect(status.body.ExportJobProperties.JobStatus).toBe("COMPLETED");
  });
});

describe("HealthLake data plane", () => {
  it("serves FHIR per datastore behind SigV4", async () => {
    const app = startService();
    const patient = await signed(app, "GET", `/datastore/${DEFAULT_DATASTORE_ID}/r4/Patient/syn-patient-001`);
    expect(patient.status).toBe(200);
    expect(patient.body.id).toBe("syn-patient-001");
    expect((await app.request(`${origin}/datastore/${DEFAULT_DATASTORE_ID}/r4/Patient/syn-patient-001`)).status).toBe(
      403,
    );
    const created = await control(app, "CreateFHIRDatastore", { DatastoreName: "empty", DatastoreTypeVersion: "R4" });
    const id = created.body.DatastoreId;
    expect((await signed(app, "GET", `/datastore/${id}/r4/Patient/syn-patient-001`)).status).toBe(404);
    const posted = await signed(
      app,
      "POST",
      `/datastore/${id}/r4/Patient`,
      { resourceType: "Patient", name: [{ family: "Example" }] },
      { "content-type": "application/fhir+json" },
    );
    expect(posted.status).toBe(201);
    const search = await signed(app, "GET", `/datastore/${id}/r4/Patient?family=Example`);
    expect(search.body.total).toBe(1);
    expect((await signed(app, "GET", `/datastore/${"0".repeat(32)}/r4/Patient`)).body.__type).toBe(
      "ResourceNotFoundException",
    );
  });

  it("takes configured datastores and credentials", async () => {
    const credentials = { accessKeyId: "AKIASYNTHETIC0000001", secretAccessKey: "synthetic-secret" };
    const app = startService({
      credentials: [credentials],
      datastores: [{ name: "configured", preload: false, id: "a".repeat(32) }],
    });
    expect((await control(app, "ListFHIRDatastores", {})).status).toBe(403);
    const list = await control(app, "ListFHIRDatastores", {}, credentials);
    expect(list.body.DatastorePropertiesList.map((d: { DatastoreId: string }) => d.DatastoreId)).toEqual([
      "a".repeat(32),
    ]);
  });
});
