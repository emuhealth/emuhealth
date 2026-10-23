import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { createFhirInstance, getFhirStore, type FhirInstance } from "@emuhealth/fhir-core";
import { verifySigV4, type Credentials } from "./sigv4.js";

export { verifySigV4, type Credentials, type SigV4Result } from "./sigv4.js";

/**
 * AWS HealthLake emulator: the HealthLake JSON control plane (X-Amz-Target HealthLake.*) for datastores and import
 * and export jobs, and a FHIR R4 data plane per datastore at /datastore/{id}/r4, with SigV4 verification on every
 * request. emuhealth is not affiliated with Amazon Web Services.
 */
export interface HealthLakeSeedConfig {
  port?: number;
  /** Region in ARNs and endpoints. Default us-east-1. */
  region?: string;
  /** Account id in ARNs. Default 123456789012. */
  accountId?: string;
  /** Access keys that verify. Default: AWS's documented example key pair. */
  credentials?: Credentials[];
  /** Datastores to create at startup. Default: one ACTIVE datastore preloaded with the synthetic population. */
  datastores?: Array<{ id?: string; name: string; preload?: boolean }>;
}

export const EXAMPLE_CREDENTIALS: Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
/** The id of the default datastore. HealthLake datastore ids are 32 hexadecimal characters. */
export const DEFAULT_DATASTORE_ID = "5e7e0000000000000000000000000001";

const DATA_KEY = "healthlake.data";
const SERVICE = "healthlake";
const SERVICE_LABEL = "HealthLake";

interface Datastore {
  id: string;
  name: string;
  status: "ACTIVE" | "DELETED";
  createdAt: number;
  preload: boolean;
  instance: FhirInstance;
}

interface Job {
  JobId: string;
  JobName?: string;
  JobStatus: string;
  SubmitTime: number;
  EndTime: number;
  DatastoreId: string;
  DataAccessRoleArn?: string;
  InputDataConfig?: unknown;
  OutputDataConfig?: unknown;
  JobOutputDataConfig?: unknown;
  Message?: string;
  kind: "import" | "export";
}

interface Data {
  region: string;
  accountId: string;
  credentials: Credentials[];
  datastores: Map<string, Datastore>;
  jobs: Job[];
}

class AwsError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

type AnyContext = Context<AppEnv>;

/** Per-store access to the plugin's state and datastore factory; a reset clears store data but not this. */
const runtime = new WeakMap<Store, { data(): Data; create(name: string, preload: boolean, id?: string): Datastore }>();

export const healthlakePlugin: ServicePlugin = {
  name: "healthlake",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/+$/, "");
    const data = (): Data => {
      let d = store.getData<Data>(DATA_KEY);
      if (!d) {
        d = {
          region: "us-east-1",
          accountId: "123456789012",
          credentials: [EXAMPLE_CREDENTIALS],
          datastores: new Map(),
          jobs: [],
        };
        store.setData(DATA_KEY, d);
      }
      return d;
    };
    const endpoint = (id: string) => `${origin}/datastore/${id}/r4/`;
    const arn = (id: string) => `arn:aws:healthlake:${data().region}:${data().accountId}:datastore/fhir/${id}`;
    const properties = (ds: Datastore) => ({
      DatastoreId: ds.id,
      DatastoreArn: arn(ds.id),
      DatastoreName: ds.name,
      DatastoreStatus: ds.status,
      CreatedAt: ds.createdAt / 1000,
      DatastoreTypeVersion: "R4",
      DatastoreEndpoint: endpoint(ds.id),
      SseConfiguration: { KmsEncryptionConfig: { CmkType: "AWS_OWNED_KMS_KEY" } },
      ...(ds.preload ? { PreloadDataConfig: { PreloadDataType: "SYNTHEA" } } : {}),
      IdentityProviderConfiguration: { AuthorizationStrategy: "AWS_AUTH", FineGrainedAuthorizationEnabled: false },
    });
    const createDatastore = (name: string, preload: boolean, id = randomBytes(16).toString("hex")): Datastore => {
      const ds: Datastore = {
        id,
        name,
        status: "ACTIVE",
        createdAt: Date.now(),
        preload,
        instance: createFhirInstance({
          baseUrl: origin,
          basePath: `/datastore/${id}/r4`,
          software: { name: "emuhealth HealthLake emulator" },
          description:
            "Emulates an AWS HealthLake FHIR R4 datastore with synthetic data. Not affiliated with Amazon Web Services.",
          inspectorPath: false,
          generate: preload,
        }),
      };
      data().datastores.set(id, ds);
      return ds;
    };
    runtime.set(store, { data, create: createDatastore });

    const aws = (c: AnyContext, status: number, type: string, message: string) =>
      c.body(JSON.stringify({ __type: type, message }), status as never, {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amzn-ErrorType": type,
        "x-amzn-RequestId": randomUUID(),
      });
    const verify = async (c: AnyContext) => {
      const result = await verifySigV4(c.req.raw, SERVICE, data().credentials);
      if (!result.ok)
        throw new AwsError(
          result.error!.type === "MissingAuthenticationTokenException" ? 403 : 403,
          result.error!.type,
          result.error!.message,
        );
    };
    const datastore = (id: unknown): Datastore => {
      const ds = typeof id === "string" ? data().datastores.get(id) : undefined;
      if (!ds || ds.status === "DELETED")
        throw new AwsError(400, "ResourceNotFoundException", `Datastore ${String(id)} does not exist.`);
      return ds;
    };

    // Control plane: POST / with X-Amz-Target: HealthLake.<Operation>.
    const operations: Record<string, (input: Record<string, unknown>) => unknown> = {
      CreateFHIRDatastore: (input) => {
        if (typeof input.DatastoreName !== "string" && input.DatastoreName !== undefined)
          throw new AwsError(400, "ValidationException", "DatastoreName must be a string.");
        if (input.DatastoreTypeVersion !== "R4")
          throw new AwsError(400, "ValidationException", "DatastoreTypeVersion must be R4.");
        const preload =
          (input.PreloadDataConfig as { PreloadDataType?: string } | undefined)?.PreloadDataType === "SYNTHEA";
        const ds = createDatastore(String(input.DatastoreName ?? "datastore"), preload);
        // The emulator creates datastores immediately; HealthLake reports CREATING and becomes ACTIVE later.
        return {
          DatastoreId: ds.id,
          DatastoreArn: arn(ds.id),
          DatastoreStatus: "CREATING",
          DatastoreEndpoint: endpoint(ds.id),
        };
      },
      DescribeFHIRDatastore: (input) => ({ DatastoreProperties: properties(datastore(input.DatastoreId)) }),
      ListFHIRDatastores: (input) => {
        const filter = (input.Filter ?? {}) as { DatastoreName?: string; DatastoreStatus?: string };
        const list = [...data().datastores.values()]
          .filter(
            (ds) =>
              (!filter.DatastoreName || ds.name === filter.DatastoreName) &&
              (!filter.DatastoreStatus || ds.status === filter.DatastoreStatus),
          )
          .map(properties);
        return { DatastorePropertiesList: list };
      },
      DeleteFHIRDatastore: (input) => {
        const ds = datastore(input.DatastoreId);
        ds.status = "DELETED";
        return {
          DatastoreId: ds.id,
          DatastoreArn: arn(ds.id),
          DatastoreStatus: "DELETING",
          DatastoreEndpoint: endpoint(ds.id),
        };
      },
      StartFHIRImportJob: (input) => {
        const ds = datastore(input.DatastoreId);
        if (!input.InputDataConfig || !input.JobOutputDataConfig || !input.DataAccessRoleArn)
          throw new AwsError(
            400,
            "ValidationException",
            "InputDataConfig, JobOutputDataConfig, and DataAccessRoleArn are required.",
          );
        const job: Job = {
          kind: "import",
          JobId: randomBytes(16).toString("hex"),
          JobName: input.JobName as string | undefined,
          JobStatus: "COMPLETED",
          SubmitTime: Date.now() / 1000,
          EndTime: Date.now() / 1000,
          DatastoreId: ds.id,
          DataAccessRoleArn: String(input.DataAccessRoleArn),
          InputDataConfig: input.InputDataConfig,
          JobOutputDataConfig: input.JobOutputDataConfig,
          Message: "The emulator does not read from S3; load data through the FHIR API instead.",
        };
        data().jobs.push(job);
        return { JobId: job.JobId, JobStatus: "SUBMITTED", DatastoreId: ds.id };
      },
      StartFHIRExportJob: (input) => {
        const ds = datastore(input.DatastoreId);
        if (!input.OutputDataConfig || !input.DataAccessRoleArn)
          throw new AwsError(400, "ValidationException", "OutputDataConfig and DataAccessRoleArn are required.");
        const job: Job = {
          kind: "export",
          JobId: randomBytes(16).toString("hex"),
          JobName: input.JobName as string | undefined,
          JobStatus: "COMPLETED",
          SubmitTime: Date.now() / 1000,
          EndTime: Date.now() / 1000,
          DatastoreId: ds.id,
          DataAccessRoleArn: String(input.DataAccessRoleArn),
          OutputDataConfig: input.OutputDataConfig,
          Message: "The emulator does not write to S3; use the datastore's FHIR $export instead.",
        };
        data().jobs.push(job);
        return { JobId: job.JobId, JobStatus: "SUBMITTED", DatastoreId: ds.id };
      },
    };
    const jobView = (job: Job) => {
      const { kind: _kind, ...rest } = job;
      return rest;
    };
    for (const kind of ["Import", "Export"] as const) {
      operations[`DescribeFHIR${kind}Job`] = (input) => {
        const job = data().jobs.find(
          (j) => j.JobId === input.JobId && j.DatastoreId === input.DatastoreId && j.kind === kind.toLowerCase(),
        );
        if (!job) throw new AwsError(400, "ResourceNotFoundException", `Job ${String(input.JobId)} does not exist.`);
        return { [`${kind}JobProperties`]: jobView(job) };
      };
      operations[`ListFHIR${kind}Jobs`] = (input) => {
        datastore(input.DatastoreId);
        return {
          [`${kind}JobPropertiesList`]: data()
            .jobs.filter((j) => j.DatastoreId === input.DatastoreId && j.kind === kind.toLowerCase())
            .map(jobView),
        };
      };
    }

    app.post("/", async (c) => {
      const target = c.req.header("X-Amz-Target") ?? "";
      const operation = target.startsWith("HealthLake.") ? target.slice("HealthLake.".length) : "";
      try {
        await verify(c);
        const handler = operations[operation];
        if (!handler) throw new AwsError(400, "UnknownOperationException", `Unknown operation ${target}`);
        const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        return c.body(JSON.stringify(handler(input)), 200, {
          "Content-Type": "application/x-amz-json-1.0",
          "x-amzn-RequestId": randomUUID(),
        });
      } catch (err) {
        if (err instanceof AwsError) return aws(c, err.status, err.type, err.message);
        throw err;
      }
    });

    // Data plane: each datastore's FHIR R4 API, signed with SigV4.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      app.on(method, "/datastore/:id/r4/:rest{.*}", async (c) => {
        try {
          await verify(c);
          return await datastore(c.req.param("id")).instance.forward(c);
        } catch (err) {
          if (err instanceof AwsError) return aws(c, err.status, err.type, err.message);
          throw err;
        }
      });

    app.get("/_inspector", (c) => {
      const rows = [...data().datastores.values()].map((ds) => {
        const counts = getFhirStore(ds.instance.store).listCurrent("Patient").length;
        return `<tr><td>${escapeHtml(ds.id)}</td><td>${escapeHtml(ds.name)}</td><td>${ds.status}</td><td>${escapeHtml(endpoint(ds.id))}</td><td>${counts}</td></tr>`;
      });
      const body = `<div class="inspector-section"><h2>Datastores</h2><p>Sign requests with SigV4 for service healthlake, for example with access key ${escapeHtml(EXAMPLE_CREDENTIALS.accessKeyId)}.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>id</th><th>name</th><th>status</th><th>endpoint</th><th>patients</th></tr></thead><tbody>${
        rows.length ? rows.join("") : '<tr><td colspan="5"><div class="inspector-empty">No datastores</div></td></tr>'
      }</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "HealthLake inspector",
          [{ id: "datastores", label: "Datastores", href: "/_inspector" }],
          "datastores",
          body,
          SERVICE_LABEL,
        ),
      );
    });
  },
  seed(store: Store): void {
    runtime.get(store)?.create("synthetic", true, DEFAULT_DATASTORE_ID);
  },
};

export function seedFromConfig(store: Store, _baseUrl: string, config: HealthLakeSeedConfig): void {
  const rt = runtime.get(store);
  if (!rt) throw new Error("healthlake: register the plugin before seeding");
  const d = rt.data();
  if (config.region !== undefined) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(config.region)) throw new Error("healthlake.region must look like us-east-1");
    d.region = config.region;
  }
  if (config.accountId !== undefined) {
    if (!/^\d{12}$/.test(config.accountId)) throw new Error("healthlake.accountId must be 12 digits");
    d.accountId = config.accountId;
  }
  if (config.credentials !== undefined) {
    if (!Array.isArray(config.credentials) || config.credentials.some((c) => !c?.accessKeyId || !c?.secretAccessKey))
      throw new Error("healthlake.credentials must be an array of { accessKeyId, secretAccessKey }");
    d.credentials = config.credentials;
  }
  if (config.datastores !== undefined) {
    if (!Array.isArray(config.datastores)) throw new Error("healthlake.datastores must be an array");
    d.datastores.clear();
    for (const [i, ds] of config.datastores.entries()) {
      if (!ds || typeof ds.name !== "string") throw new Error(`healthlake.datastores[${i}].name is required`);
      if (ds.id !== undefined && !/^[0-9a-f]{32}$/.test(ds.id))
        throw new Error(`healthlake.datastores[${i}].id must be 32 hexadecimal characters`);
      rt.create(ds.name, ds.preload ?? false, ds.id);
    }
  }
}

export default healthlakePlugin;
