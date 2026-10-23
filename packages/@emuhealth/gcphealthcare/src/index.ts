import { randomUUID } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { FHIR_JSON, createFhirInstance, getFhirStore, operationOutcome, type FhirInstance } from "@emuhealth/fhir-core";

/**
 * Google Cloud Healthcare API emulator (FHIR stores first): datasets and FHIR stores under
 * /v1/projects/{project}/locations/{location}, and an isolated FHIR R4 API per store. emuhealth is not affiliated
 * with Google.
 */
export interface GcpHealthcareSeedConfig {
  port?: number;
  /** Datasets and their FHIR stores at startup. Default: synthetic-project/us-central1/synthetic-dataset with synthetic-fhir-store, preloaded. */
  datasets?: Array<{
    project: string;
    location: string;
    id: string;
    timeZone?: string;
    fhirStores?: Array<{ id: string; enableUpdateCreate?: boolean; preload?: boolean }>;
  }>;
}

const DATA_KEY = "gcphealthcare.data";
const SERVICE_LABEL = "Cloud Healthcare";
const ID = /^[A-Za-z0-9_\-.]{1,256}$/;

interface FhirStoreState {
  name: string;
  enableUpdateCreate: boolean;
  disableReferentialIntegrity: boolean;
  labels: Record<string, string>;
  instance: FhirInstance;
}
interface Dataset {
  name: string;
  timeZone: string;
  fhirStores: Map<string, FhirStoreState>;
}
interface Data {
  datasets: Map<string, Dataset>;
  operations: Map<string, Record<string, unknown>>;
}

class GoogleError extends Error {
  constructor(
    public readonly code: number,
    public readonly status: string,
    message: string,
  ) {
    super(message);
  }
}

type AnyContext = Context<AppEnv>;

const runtime = new WeakMap<
  Store,
  {
    data(): Data;
    createDataset(project: string, location: string, id: string, timeZone?: string): Dataset;
    createStore(
      dataset: Dataset,
      id: string,
      options: { enableUpdateCreate?: boolean; preload?: boolean },
    ): FhirStoreState;
  }
>();

export const gcphealthcarePlugin: ServicePlugin = {
  name: "gcphealthcare",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const origin = baseUrl.replace(/\/+$/, "");
    const data = (): Data => {
      let d = store.getData<Data>(DATA_KEY);
      if (!d) {
        d = { datasets: new Map(), operations: new Map() };
        store.setData(DATA_KEY, d);
      }
      return d;
    };
    const createDataset = (project: string, location: string, id: string, timeZone = "UTC"): Dataset => {
      const name = `projects/${project}/locations/${location}/datasets/${id}`;
      const dataset: Dataset = { name, timeZone, fhirStores: new Map() };
      data().datasets.set(name, dataset);
      return dataset;
    };
    const createStore = (
      dataset: Dataset,
      id: string,
      options: {
        enableUpdateCreate?: boolean;
        preload?: boolean;
        disableReferentialIntegrity?: boolean;
        labels?: Record<string, string>;
      },
    ): FhirStoreState => {
      const name = `${dataset.name}/fhirStores/${id}`;
      const state: FhirStoreState = {
        name,
        enableUpdateCreate: options.enableUpdateCreate ?? false,
        disableReferentialIntegrity: options.disableReferentialIntegrity ?? false,
        labels: options.labels ?? {},
        instance: createFhirInstance({
          baseUrl: origin,
          basePath: `/v1/${name}/fhir`,
          software: { name: "emuhealth Cloud Healthcare emulator" },
          description:
            "Emulates a Google Cloud Healthcare API FHIR store with synthetic data. Not affiliated with Google.",
          inspectorPath: false,
          generate: options.preload ?? false,
        }),
      };
      dataset.fhirStores.set(id, state);
      return state;
    };
    runtime.set(store, { data, createDataset, createStore });

    const googleError = (c: AnyContext, err: GoogleError) =>
      c.json({ error: { code: err.code, message: err.message, status: err.status } }, err.code as never);
    const authorized = (c: AnyContext) => /^Bearer\s+\S+/i.test(c.req.header("Authorization") ?? "");
    const run = async (c: AnyContext, handler: () => Response | Promise<Response>) => {
      try {
        if (!authorized(c))
          throw new GoogleError(
            401,
            "UNAUTHENTICATED",
            "Request is missing required authentication credential. Expected OAuth 2 access token.",
          );
        return await handler();
      } catch (err) {
        if (err instanceof GoogleError) return googleError(c, err);
        throw err;
      }
    };
    const datasetOf = (c: AnyContext): Dataset => {
      const name = `projects/${c.req.param("project")}/locations/${c.req.param("location")}/datasets/${c.req.param("dataset")}`;
      const dataset = data().datasets.get(name);
      if (!dataset) throw new GoogleError(404, "NOT_FOUND", `dataset not found: ${name}`);
      return dataset;
    };
    const storeView = (s: FhirStoreState) => ({
      name: s.name,
      version: "R4",
      enableUpdateCreate: s.enableUpdateCreate,
      disableReferentialIntegrity: s.disableReferentialIntegrity,
      labels: s.labels,
      complexDataTypeReferenceParsing: "ENABLED",
    });
    const datasetView = (d: Dataset) => ({ name: d.name, timeZone: d.timeZone });
    const page = <T>(c: AnyContext, items: T[]) => {
      const size = Math.min(Math.max(Number(c.req.query("pageSize") ?? 100) || 100, 1), 1000);
      const offset = Number(Buffer.from(c.req.query("pageToken") ?? "", "base64url").toString() || 0) || 0;
      const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : undefined;
      return { items: items.slice(offset, offset + size), next };
    };
    const P = "/v1/projects/:project/locations/:location";

    // Datasets
    app.post(`${P}/datasets`, (c) =>
      run(c, async () => {
        const id = c.req.query("datasetId") ?? "";
        if (!ID.test(id))
          throw new GoogleError(400, "INVALID_ARGUMENT", "datasetId is required and must match [A-Za-z0-9_-.]{1,256}");
        const name = `projects/${c.req.param("project")}/locations/${c.req.param("location")}/datasets/${id}`;
        if (data().datasets.has(name)) throw new GoogleError(409, "ALREADY_EXISTS", `dataset already exists: ${name}`);
        const body = (await c.req.json().catch(() => ({}))) as { timeZone?: string };
        const dataset = createDataset(c.req.param("project"), c.req.param("location"), id, body.timeZone);
        const operation = {
          name: `${dataset.name}/operations/${randomUUID().replace(/-/g, "").slice(0, 19)}`,
          metadata: {
            "@type": "type.googleapis.com/google.cloud.healthcare.v1.OperationMetadata",
            apiMethodName: "google.cloud.healthcare.v1.dataset.DatasetService.CreateDataset",
            createTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
          },
          done: true,
          response: {
            "@type": "type.googleapis.com/google.cloud.healthcare.v1.dataset.Dataset",
            ...datasetView(dataset),
          },
        };
        data().operations.set(operation.name, operation);
        return c.json(operation);
      }),
    );
    app.get(`${P}/datasets`, (c) =>
      run(c, () => {
        const prefix = `projects/${c.req.param("project")}/locations/${c.req.param("location")}/datasets/`;
        const { items, next } = page(
          c,
          [...data().datasets.values()].filter((d) => d.name.startsWith(prefix)).map(datasetView),
        );
        return c.json({ datasets: items, ...(next ? { nextPageToken: next } : {}) });
      }),
    );
    app.get(`${P}/datasets/:dataset/operations/:op`, (c) =>
      run(c, () => {
        const operation = data().operations.get(`${datasetOf(c).name}/operations/${c.req.param("op")}`);
        if (!operation) throw new GoogleError(404, "NOT_FOUND", "operation not found");
        return c.json(operation);
      }),
    );
    app.get(`${P}/datasets/:dataset`, (c) => run(c, () => c.json(datasetView(datasetOf(c)))));
    app.delete(`${P}/datasets/:dataset`, (c) =>
      run(c, () => {
        data().datasets.delete(datasetOf(c).name);
        return c.json({});
      }),
    );

    // FHIR stores
    app.post(`${P}/datasets/:dataset/fhirStores`, (c) =>
      run(c, async () => {
        const dataset = datasetOf(c);
        const id = c.req.query("fhirStoreId") ?? "";
        if (!ID.test(id))
          throw new GoogleError(
            400,
            "INVALID_ARGUMENT",
            "fhirStoreId is required and must match [A-Za-z0-9_-.]{1,256}",
          );
        if (dataset.fhirStores.has(id))
          throw new GoogleError(409, "ALREADY_EXISTS", `FHIR store already exists: ${dataset.name}/fhirStores/${id}`);
        const body = (await c.req.json().catch(() => ({}))) as {
          version?: string;
          enableUpdateCreate?: boolean;
          disableReferentialIntegrity?: boolean;
          labels?: Record<string, string>;
        };
        if (body.version !== undefined && body.version !== "R4")
          throw new GoogleError(400, "INVALID_ARGUMENT", "The emulator supports FHIR store version R4 only");
        return c.json(storeView(createStore(dataset, id, body)));
      }),
    );
    app.get(`${P}/datasets/:dataset/fhirStores`, (c) =>
      run(c, () => {
        const { items, next } = page(c, [...datasetOf(c).fhirStores.values()].map(storeView));
        return c.json({ fhirStores: items, ...(next ? { nextPageToken: next } : {}) });
      }),
    );
    const fhirStoreOf = (c: AnyContext, id: string) => {
      const dataset = datasetOf(c);
      const state = dataset.fhirStores.get(id);
      if (!state) throw new GoogleError(404, "NOT_FOUND", `FHIR store not found: ${dataset.name}/fhirStores/${id}`);
      return { dataset, state };
    };
    app.get(`${P}/datasets/:dataset/fhirStores/:store`, (c) =>
      run(c, () => c.json(storeView(fhirStoreOf(c, c.req.param("store")).state))),
    );
    app.patch(`${P}/datasets/:dataset/fhirStores/:store`, (c) =>
      run(c, async () => {
        const { state } = fhirStoreOf(c, c.req.param("store"));
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const mask = (c.req.query("updateMask") ?? "").split(",").filter(Boolean);
        if (!mask.length) throw new GoogleError(400, "INVALID_ARGUMENT", "updateMask is required");
        for (const field of mask) {
          if (field === "enableUpdateCreate") state.enableUpdateCreate = Boolean(body.enableUpdateCreate);
          else if (field === "labels") state.labels = (body.labels as Record<string, string>) ?? {};
          else if (field === "disableReferentialIntegrity")
            throw new GoogleError(400, "INVALID_ARGUMENT", "disableReferentialIntegrity cannot be changed");
          else throw new GoogleError(400, "INVALID_ARGUMENT", `Unsupported updateMask field: ${field}`);
        }
        return c.json(storeView(state));
      }),
    );
    app.delete(`${P}/datasets/:dataset/fhirStores/:store`, (c) =>
      run(c, () => {
        const { dataset, state } = fhirStoreOf(c, c.req.param("store"));
        dataset.fhirStores.delete(state.name.split("/").pop()!);
        return c.json({});
      }),
    );
    // fhirStores/{id}:export and :import return long-running operations; the emulator does not touch Cloud Storage.
    app.post(`${P}/datasets/:dataset/fhirStores/:storeAction`, (c) =>
      run(c, () => {
        const [id, action] = c.req.param("storeAction").split(":");
        const { dataset } = fhirStoreOf(c, id);
        if (action !== "export" && action !== "import")
          throw new GoogleError(404, "NOT_FOUND", `Unknown method ${action}`);
        const operation = {
          name: `${dataset.name}/operations/${randomUUID().replace(/-/g, "").slice(0, 19)}`,
          metadata: {
            "@type": "type.googleapis.com/google.cloud.healthcare.v1.OperationMetadata",
            apiMethodName: `google.cloud.healthcare.v1.fhir.FhirStoreService.${action === "export" ? "ExportResources" : "ImportResources"}`,
            createTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            counter: { success: "0" },
          },
          done: true,
          response: {
            "@type": `type.googleapis.com/google.cloud.healthcare.v1.fhir.${action === "export" ? "Export" : "Import"}ResourcesResponse`,
          },
        };
        data().operations.set(operation.name, operation);
        return c.json(operation);
      }),
    );

    // FHIR API per store. PUT creates only when enableUpdateCreate is on, as in Cloud Healthcare.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      app.on(method, `${P}/datasets/:dataset/fhirStores/:store/fhir/:rest{.*}`, (c) =>
        run(c, async () => {
          const { state } = fhirStoreOf(c, c.req.param("store"));
          if (method === "PUT" && !state.enableUpdateCreate) {
            const [type, id] = c.req.param("rest").split("/");
            if (type && id && !getFhirStore(state.instance.store).find(type, id))
              return c.body(
                JSON.stringify(
                  operationOutcome(
                    "not-found",
                    `resource not found: ${type}/${id}; enable enableUpdateCreate on the FHIR store to create with PUT`,
                  ),
                ),
                404,
                { "Content-Type": FHIR_JSON },
              );
          }
          return state.instance.forward(c);
        }),
      );

    app.get("/_inspector", (c) => {
      const rows = [...data().datasets.values()].flatMap((d) =>
        [...d.fhirStores.values()].map(
          (s) =>
            `<tr><td>${escapeHtml(s.name)}</td><td>${s.enableUpdateCreate}</td><td>${getFhirStore(s.instance.store).listCurrent("Patient").length}</td></tr>`,
        ),
      );
      const body = `<div class="inspector-section"><h2>FHIR stores</h2><p>FHIR API at /v1/{store name}/fhir with any Bearer token.</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>name</th><th>enableUpdateCreate</th><th>patients</th></tr></thead><tbody>${
        rows.length ? rows.join("") : '<tr><td colspan="3"><div class="inspector-empty">No FHIR stores</div></td></tr>'
      }</tbody></table></div></div>`;
      return c.html(
        renderInspectorPage(
          "Cloud Healthcare inspector",
          [{ id: "stores", label: "FHIR stores", href: "/_inspector" }],
          "stores",
          body,
          SERVICE_LABEL,
        ),
      );
    });
  },
  seed(store: Store): void {
    const rt = runtime.get(store);
    if (!rt) return;
    const dataset = rt.createDataset("synthetic-project", "us-central1", "synthetic-dataset");
    rt.createStore(dataset, "synthetic-fhir-store", { enableUpdateCreate: true, preload: true });
  },
};

export function seedFromConfig(store: Store, _baseUrl: string, config: GcpHealthcareSeedConfig): void {
  const rt = runtime.get(store);
  if (!rt) throw new Error("gcphealthcare: register the plugin before seeding");
  if (config.datasets === undefined) return;
  if (!Array.isArray(config.datasets)) throw new Error("gcphealthcare.datasets must be an array");
  rt.data().datasets.clear();
  for (const [i, d] of config.datasets.entries()) {
    for (const field of ["project", "location", "id"] as const)
      if (typeof d?.[field] !== "string" || !ID.test(d[field]))
        throw new Error(`gcphealthcare.datasets[${i}].${field} is required`);
    const dataset = rt.createDataset(d.project, d.location, d.id, d.timeZone);
    for (const [j, s] of (d.fhirStores ?? []).entries()) {
      if (typeof s?.id !== "string" || !ID.test(s.id))
        throw new Error(`gcphealthcare.datasets[${i}].fhirStores[${j}].id is required`);
      rt.createStore(dataset, s.id, s);
    }
  }
}

export default gcphealthcarePlugin;
