import { createHmac, randomBytes } from "node:crypto";
import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { USER, generateTenant, type GenerateOptions, type Obj, type Tenant } from "./data.js";

export { generateTenant, USER, type GenerateOptions, type Obj, type Tenant } from "./data.js";

/**
 * Benchling API v2 emulator: DNA and AA sequences, notebook entries, the registry, assay results, events, and
 * Svix-signed webhooks, over a synthetic tenant. emuhealth is not affiliated with Benchling.
 */
export interface BenchlingSeedConfig {
  port?: number;
  /** Generated tenant; false starts with only the user, project, folders, schemas, and registry. */
  generate?: GenerateOptions | false;
  /** Webhook subscriptions. A secret like whsec_<base64> signs deliveries the way Benchling (Svix) does. */
  webhooks?: Array<{ url: string; events?: string[]; secret?: string }>;
}

const DATA_KEY = "benchling.tenant";
const API = "/api/v2";
const SERVICE_LABEL = "Benchling";
const OWNER = "benchling";
const TENANT_ID = "ten_SYNTENANT";

function tenant(store: Store): Tenant {
  let t = store.getData<Tenant>(DATA_KEY);
  if (!t) {
    t = generateTenant();
    store.setData(DATA_KEY, t);
  }
  return t;
}

/** Svix signature: HMAC-SHA256 over "id.timestamp.body" keyed with the base64 part of whsec_ secrets. */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

const dispatcherFor = new WeakMap<Store, WebhookDispatcher>();

export function seedFromConfig(store: Store, _baseUrl: string, config: BenchlingSeedConfig): void {
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("benchling.generate must be an object of generator options or false");
    const t = generateTenant(config.generate === false ? { dnaSequences: 0 } : config.generate);
    if (config.generate === false) Object.assign(t, { aaSequences: [], entries: [], assayResults: [] });
    store.setData(DATA_KEY, t);
  }
  if (config.webhooks === undefined) return;
  if (!Array.isArray(config.webhooks)) throw new Error("benchling.webhooks must be an array");
  const webhooks = dispatcherFor.get(store);
  // A reset seeds again; replace the configured subscriptions rather than adding duplicates.
  for (const sub of webhooks?.getSubscriptions(OWNER) ?? []) webhooks?.unregister(sub.id);
  for (const [i, hook] of config.webhooks.entries()) {
    if (!hook || typeof hook.url !== "string" || !/^https?:\/\//.test(hook.url))
      throw new Error(`benchling.webhooks[${i}].url must be an http(s) URL`);
    webhooks?.register({
      url: hook.url,
      events: hook.events ?? ["*"],
      active: true,
      secret: hook.secret,
      owner: OWNER,
    });
  }
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AnyContext = Context<AppEnv>;

function error(c: AnyContext, status: number, message: string): Response {
  return c.json({ error: { message, type: "invalid_request_error", userMessage: message } }, status as never);
}

function newId(t: Tenant, prefix: string): string {
  t.counter++;
  return `${prefix}_${randomBytes(6).toString("base64url").replace(/[-_]/g, "x")}${t.counter}`;
}

/** List with Benchling's pageSize (default 50, at most 100) and opaque nextToken. */
function page<T>(items: T[], c: AnyContext): { items: T[]; nextToken: string } {
  const size = Math.min(Math.max(Number(c.req.query("pageSize") ?? 50) || 50, 1), 100);
  const token = c.req.query("nextToken");
  const offset = token ? Number(Buffer.from(token, "base64url").toString("utf8")) || 0 : 0;
  const slice = items.slice(offset, offset + size);
  return {
    items: slice,
    nextToken: offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : "",
  };
}

const now = () => new Date().toISOString();

/** Benchling field values from plain create and update input, typed by the schema's field definitions. */
function toFields(input: unknown, schema: Obj | undefined, required = false): Obj {
  const out: Obj = {};
  const defs = ((schema?.fieldDefinitions as Obj[] | undefined) ?? []) as Array<{
    name: string;
    type: string;
    isRequired?: boolean;
  }>;
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(raw)) {
    const def = defs.find((d) => d.name === name);
    if (schema && !def) throw new ApiError(400, `Unknown field ${name} for schema ${String(schema.name)}`);
    const plain = value && typeof value === "object" && "value" in (value as Obj) ? (value as Obj).value : value;
    out[name] = {
      value: plain,
      type: def?.type ?? "text",
      isMulti: false,
      displayValue: plain === null ? null : String(plain),
    };
  }
  if (required)
    for (const def of defs)
      if (def.isRequired && !(def.name in out)) throw new ApiError(400, `Field ${def.name} is required`);
  return out;
}

export const benchlingPlugin: ServicePlugin = {
  name: "benchling",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    dispatcherFor.set(store, webhooks);
    webhooks.setHeaderFactory(({ body, subscription, deliveryId }) => {
      const id = `msg_emuhealth${deliveryId}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      return {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        ...(subscription.secret
          ? { "webhook-signature": svixSignature(subscription.secret, id, timestamp, body) }
          : {}),
      };
    });
    const tokens = new Set<string>();

    /** Record an event for GET /events and deliver it to webhook subscribers. */
    const emit = (eventType: string, resource: Obj, key: string) => {
      const t = tenant(store);
      const event = {
        id: newId(t, "evt"),
        eventType,
        createdAt: now(),
        deprecated: false,
        excludedProperties: [],
        [key]: resource,
      };
      t.events.push(event);
      void webhooks.dispatch(
        eventType,
        undefined,
        {
          version: "0",
          baseURL: baseUrl,
          tenantId: TENANT_ID,
          appId: "app_SYNAPP01",
          appDefinitionId: "appdef_SYNAPP01",
          channel: "app_signals",
          message: {
            type: eventType,
            id: event.id,
            timestamp: event.createdAt,
            resourceId: resource.id,
            deprecated: false,
            excludedProperties: [],
            [key]: resource,
          },
        },
        OWNER,
      );
    };

    const run = async (c: AnyContext, handler: () => Response | Promise<Response>) => {
      try {
        return await handler();
      } catch (err) {
        if (err instanceof ApiError) return error(c, err.status, err.message);
        throw err;
      }
    };
    const body = async (c: AnyContext): Promise<Obj> => {
      try {
        const parsed = await c.req.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return parsed as Obj;
      } catch {
        throw new ApiError(400, "The request body must be a JSON object");
      }
    };

    // OAuth client credentials for apps; API keys work as Basic auth usernames.
    app.post(`${API}/token`, async (c) => {
      const form = new URLSearchParams(await c.req.text());
      if (form.get("grant_type") !== "client_credentials")
        return c.json({ error: "unsupported_grant_type", error_description: "Use grant_type=client_credentials" }, 400);
      const token = `syn_${randomBytes(18).toString("base64url")}`;
      tokens.add(token);
      return c.json({ access_token: token, token_type: "Bearer", expires_in: 900 });
    });

    // The core router has no trailing wildcards, so the guard matches any path under the API with a pattern.
    app.use(`${API}/:rest{.*}`, async (c, next) => {
      if (c.req.path === `${API}/token`) return next();
      const auth = c.req.header("Authorization") ?? "";
      const basic = /^Basic\s+(.+)$/i.exec(auth);
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
      const key = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":")[0] : undefined;
      if (!key && !(bearer && tokens.has(bearer)))
        return error(
          c,
          401,
          "Authenticate with an API key as the Basic auth username, or a Bearer token from /api/v2/token",
        );
      return next();
    });

    const t = () => tenant(store);
    const byId = (list: Obj[], id: string, what: string) => {
      const found = list.find((x) => x.id === id);
      if (!found) throw new ApiError(404, `${what} ${id} not found`);
      return found;
    };
    const apiUrl = (path: string) => `${baseUrl.replace(/\/+$/, "")}${API}${path}`;

    for (const [path, key] of [
      ["projects", "projects"],
      ["folders", "folders"],
      ["registries", "registries"],
      ["entity-schemas", "entitySchemas"],
      ["assay-result-schemas", "assayResultSchemas"],
    ] as const) {
      app.get(`${API}/${path}`, (c) => {
        const { items, nextToken } = page(t()[key], c);
        return c.json({ [key]: items, nextToken });
      });
      app.get(`${API}/${path}/:id`, (c) => run(c, () => c.json(byId(t()[key], c.req.param("id"), path))));
    }

    // Sequences: the same CRUD for DNA (bases) and AA (aminoAcids).
    for (const kind of [
      {
        path: "dna-sequences",
        key: "dnaSequences",
        prefix: "seq",
        residues: "bases",
        alphabet: /^[ACGTUNRYKMSWBDHV]*$/i,
      },
      { path: "aa-sequences", key: "aaSequences", prefix: "prtn", residues: "aminoAcids", alphabet: /^[A-Z*]*$/i },
    ] as const) {
      const list = () => t()[kind.key];
      const schemaFor = (id: unknown) =>
        id === undefined || id === null ? undefined : byId(t().entitySchemas, String(id), "Schema");

      app.get(`${API}/${kind.path}`, (c) => {
        const q = (name: string) => c.req.query(name);
        let items = list();
        if (q("name")) items = items.filter((x) => x.name === q("name"));
        if (q("nameIncludes"))
          items = items.filter((x) => String(x.name).toLowerCase().includes(q("nameIncludes")!.toLowerCase()));
        if (q("folderId")) items = items.filter((x) => x.folderId === q("folderId"));
        if (q("schemaId")) items = items.filter((x) => (x.schema as Obj | null)?.id === q("schemaId"));
        if (q("registryId")) items = items.filter((x) => x.registryId === q("registryId"));
        const registryIds = q("entityRegistryIds.anyOf");
        if (registryIds) items = items.filter((x) => registryIds.split(",").includes(String(x.entityRegistryId)));
        const archived = q("archiveReason");
        items = archived
          ? items.filter((x) => (x.archiveRecord as Obj | null)?.reason === archived)
          : items.filter((x) => !x.archiveRecord);
        if (q("sort")?.startsWith("name"))
          items = [...items].sort((a, b) => String(a.name).localeCompare(String(b.name)));
        else items = [...items].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
        const { items: shown, nextToken } = page(items, c);
        return c.json({ [kind.key]: shown, nextToken });
      });

      app.get(`${API}/${kind.path}/:id`, (c) => run(c, () => c.json(byId(list(), c.req.param("id"), "Sequence"))));

      app.post(`${API}/${kind.path}`, (c) =>
        run(c, async () => {
          const input = await body(c);
          if (typeof input.name !== "string" || !input.name) throw new ApiError(400, "name is required");
          const residues = String(input[kind.residues] ?? "");
          if (!kind.alphabet.test(residues)) throw new ApiError(400, `${kind.residues} has invalid characters`);
          if (input.folderId !== undefined) byId(t().folders, String(input.folderId), "Folder");
          const schema = schemaFor(input.schemaId);
          const id = newId(t(), kind.prefix);
          const created: Obj = {
            id,
            name: input.name,
            [kind.residues]: residues.toUpperCase(),
            length: residues.length,
            ...(kind.key === "dnaSequences" ? { isCircular: Boolean(input.isCircular) } : {}),
            folderId: input.folderId ?? null,
            schema: schema ? { id: schema.id, name: schema.name } : null,
            fields: toFields(input.fields, schema, true),
            customFields: input.customFields ?? {},
            aliases: Array.isArray(input.aliases) ? input.aliases : [],
            annotations: Array.isArray(input.annotations) ? input.annotations : [],
            entityRegistryId: null,
            registryId: null,
            creator: USER,
            createdAt: now(),
            modifiedAt: now(),
            archiveRecord: null,
            webURL: `${baseUrl}/${kind.prefix}/${id}`,
            apiURL: apiUrl(`/${kind.path}/${id}`),
          };
          list().push(created);
          return c.json(created, 201);
        }),
      );

      app.patch(`${API}/${kind.path}/:id`, (c) =>
        run(c, async () => {
          const existing = byId(list(), c.req.param("id"), "Sequence");
          const input = await body(c);
          for (const name of ["name", "folderId", "aliases", "customFields", "isCircular", "annotations"])
            if (input[name] !== undefined) existing[name] = input[name];
          if (input[kind.residues] !== undefined) {
            const residues = String(input[kind.residues]);
            if (!kind.alphabet.test(residues)) throw new ApiError(400, `${kind.residues} has invalid characters`);
            existing[kind.residues] = residues.toUpperCase();
            existing.length = residues.length;
          }
          if (input.fields !== undefined) {
            const schema = schemaFor((existing.schema as Obj | null)?.id);
            existing.fields = { ...(existing.fields as Obj), ...toFields(input.fields, schema) };
          }
          existing.modifiedAt = now();
          return c.json(existing);
        }),
      );

      // POST /dna-sequences:archive and :unarchive. The router reads ":action" as a parameter, so the captured
      // value starts with the colon.
      const idsKey = kind.key === "dnaSequences" ? "dnaSequenceIds" : "aaSequenceIds";
      app.post(`${API}/${kind.path}:action`, (c) =>
        run(c, async () => {
          const action = c.req.param("action").replace(/^:/, "");
          if (action !== "archive" && action !== "unarchive") throw new ApiError(404, `Unknown action ${action}`);
          const input = await body(c);
          const ids = (input[idsKey] as string[] | undefined) ?? [];
          for (const id of ids)
            byId(list(), id, "Sequence").archiveRecord =
              action === "archive" ? { reason: String(input.reason ?? "Other") } : null;
          return c.json({ [idsKey]: ids });
        }),
      );
    }

    // Registry

    const entity = (id: string): Obj | undefined => [...t().dnaSequences, ...t().aaSequences].find((x) => x.id === id);

    app.post(`${API}/registries/:id`, (c) =>
      run(c, async () => {
        // The action rides on the id segment: /registries/{id}:register-entities.
        const [registryId, action] = c.req.param("id").split(":");
        if (action !== "register-entities") throw new ApiError(404, `Unknown registry action ${action ?? ""}`);
        const registry = byId(t().registries, registryId, "Registry");
        const input = await body(c);
        const ids = input.entityIds;
        if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, "entityIds is required");
        const strategy = String(input.namingStrategy ?? "NEW_IDS");
        const registered: Obj[] = [];
        for (const id of ids as string[]) {
          const target = entity(id);
          if (!target) throw new ApiError(404, `Entity ${id} not found`);
          if (target.entityRegistryId) continue;
          const schema = t().entitySchemas.find((s) => s.id === (target.schema as Obj | null)?.id);
          if (!schema) throw new ApiError(400, `Entity ${id} needs a schema to be registered`);
          const prefix = String(schema.prefix);
          const used = [...t().dnaSequences, ...t().aaSequences]
            .map((x) => String(x.entityRegistryId ?? ""))
            .filter((r) => r.startsWith(prefix))
            .map((r) => Number(r.slice(prefix.length)) || 0);
          target.entityRegistryId = `${prefix}${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
          if (strategy === "SET_FROM_NAME_PARTS" || strategy === "REPLACE_NAMES_FROM_PARTS")
            target.name = target.entityRegistryId;
          target.registryId = registry.id;
          target.modifiedAt = now();
          registered.push(target);
          emit("v2.entity.registered", target, "entity");
        }
        const task = { id: newId(t(), "task"), status: "SUCCEEDED", response: { entities: registered } };
        t().tasks.push(task);
        return c.json({ taskId: task.id }, 202);
      }),
    );

    app.get(`${API}/registries/:id/registered-entities`, (c) =>
      run(c, () => {
        const registry = byId(t().registries, c.req.param("id"), "Registry");
        const wanted = (c.req.query("entityRegistryIds") ?? "").split(",").filter(Boolean);
        const entities = [...t().dnaSequences, ...t().aaSequences].filter(
          (x) => x.registryId === registry.id && (wanted.length === 0 || wanted.includes(String(x.entityRegistryId))),
        );
        return c.json({ entities });
      }),
    );

    app.get(`${API}/tasks/:id`, (c) => run(c, () => c.json(byId(t().tasks, c.req.param("id"), "Task"))));

    // Notebook entries

    app.get(`${API}/entries`, (c) => {
      let items = t().entries.filter((x) => !x.archiveRecord);
      const folderId = c.req.query("folderId");
      if (folderId) items = items.filter((x) => x.folderId === folderId);
      const name = c.req.query("name");
      if (name) items = items.filter((x) => x.name === name);
      const { items: shown, nextToken } = page(items, c);
      return c.json({ entries: shown, nextToken });
    });
    app.get(`${API}/entries/:id`, (c) =>
      run(c, () => c.json({ entry: byId(t().entries, c.req.param("id"), "Entry") })),
    );
    app.post(`${API}/entries`, (c) =>
      run(c, async () => {
        const input = await body(c);
        if (typeof input.name !== "string" || !input.name) throw new ApiError(400, "name is required");
        if (typeof input.folderId !== "string") throw new ApiError(400, "folderId is required");
        byId(t().folders, input.folderId, "Folder");
        const id = newId(t(), "etr");
        const created: Obj = {
          id,
          name: input.name,
          displayId: `EXP${String(t().entries.length + 1).padStart(3, "0")}`,
          folderId: input.folderId,
          authors: [USER],
          schema: null,
          fields: toFields(input.fields, undefined),
          customFields: input.customFields ?? {},
          days: [],
          reviewRecord: null,
          creator: USER,
          createdAt: now(),
          modifiedAt: now(),
          archiveRecord: null,
          webURL: `${baseUrl}/etr/${id}`,
          apiURL: apiUrl(`/entries/${id}`),
        };
        t().entries.push(created);
        emit("v2.entry.created", created, "entry");
        return c.json(created, 201);
      }),
    );
    app.patch(`${API}/entries/:id`, (c) =>
      run(c, async () => {
        const existing = byId(t().entries, c.req.param("id"), "Entry");
        const input = await body(c);
        if (input.name !== undefined) existing.name = input.name;
        if (input.folderId !== undefined) existing.folderId = byId(t().folders, String(input.folderId), "Folder").id;
        if (input.fields !== undefined) {
          existing.fields = { ...(existing.fields as Obj), ...toFields(input.fields, undefined) };
          emit("v2.entry.updated.fields", existing, "entry");
        }
        existing.modifiedAt = now();
        return c.json(existing);
      }),
    );

    // Assay results

    app.get(`${API}/assay-results`, (c) =>
      run(c, () => {
        const schemaId = c.req.query("schemaId");
        if (!schemaId) throw new ApiError(400, "schemaId is required");
        let items = t().assayResults.filter((r) => (r.schema as Obj).id === schemaId);
        const entityIds = c.req.query("entityIds")?.split(",");
        if (entityIds)
          items = items.filter((r) =>
            Object.values(r.fields as Record<string, Obj>).some(
              (f) => f.type === "entity_link" && entityIds.includes(String(f.value)),
            ),
          );
        const { items: shown, nextToken } = page(items, c);
        return c.json({ assayResults: shown, nextToken });
      }),
    );
    app.get(`${API}/assay-results/:id`, (c) =>
      run(c, () => c.json(byId(t().assayResults, c.req.param("id"), "Assay result"))),
    );
    app.post(`${API}/assay-results`, (c) =>
      run(c, async () => {
        const input = await body(c);
        const results = input.assayResults;
        if (!Array.isArray(results) || results.length === 0) throw new ApiError(400, "assayResults is required");
        const created = (results as Obj[]).map((r) => {
          const schema = byId(t().assayResultSchemas, String(r.schemaId), "Schema");
          if (typeof r.projectId !== "string") throw new ApiError(400, "projectId is required");
          byId(t().projects, r.projectId, "Project");
          const fields = toFields(r.fields, schema, true);
          for (const [name, f] of Object.entries(fields as Record<string, Obj>))
            if (f.type === "entity_link" && !entity(String(f.value)))
              throw new ApiError(400, `Field ${name} links to unknown entity ${String(f.value)}`);
          return {
            id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
            schema: { id: schema.id, name: schema.name },
            projectId: r.projectId,
            fields,
            isReviewed: false,
            creator: USER,
            createdAt: now(),
            modifiedAt: now(),
            archiveRecord: null,
          };
        });
        t().assayResults.push(...created);
        return c.json({ assayResults: created.map((r) => r.id) }, 200);
      }),
    );

    // Events, for apps that poll instead of taking webhooks.
    app.get(`${API}/events`, (c) => {
      let items = t().events;
      const since = c.req.query("createdAt.gte");
      if (since) items = items.filter((e) => String(e.createdAt) >= since);
      const types = c.req.query("eventTypes")?.split(",");
      if (types) items = items.filter((e) => types.includes(String(e.eventType)));
      const { items: shown, nextToken } = page(items, c);
      return c.json({ events: shown, nextToken });
    });

    app.get("/_inspector", (c) => {
      const tab = c.req.query("tab") ?? "dna";
      const tabs = [
        { id: "dna", label: `DNA sequences (${t().dnaSequences.length})`, href: "/_inspector?tab=dna" },
        { id: "aa", label: `AA sequences (${t().aaSequences.length})`, href: "/_inspector?tab=aa" },
        { id: "entries", label: `Entries (${t().entries.length})`, href: "/_inspector?tab=entries" },
        { id: "results", label: `Assay results (${t().assayResults.length})`, href: "/_inspector?tab=results" },
        { id: "events", label: `Events (${t().events.length})`, href: "/_inspector?tab=events" },
      ];
      const active = tabs.some((x) => x.id === tab) ? tab : "dna";
      const views: Record<string, { head: string[]; rows: string[][] }> = {
        dna: {
          head: ["id", "name", "registry id", "length"],
          rows: t().dnaSequences.map((s) => [
            String(s.id),
            String(s.name),
            String(s.entityRegistryId ?? ""),
            String(s.length),
          ]),
        },
        aa: {
          head: ["id", "name", "registry id", "length"],
          rows: t().aaSequences.map((s) => [
            String(s.id),
            String(s.name),
            String(s.entityRegistryId ?? ""),
            String(s.length),
          ]),
        },
        entries: {
          head: ["id", "display id", "name", "modified"],
          rows: t().entries.map((e) => [String(e.id), String(e.displayId), String(e.name), String(e.modifiedAt)]),
        },
        results: {
          head: ["id", "schema", "fields"],
          rows: t().assayResults.map((r) => [
            String(r.id),
            String((r.schema as Obj).name),
            Object.entries(r.fields as Record<string, Obj>)
              .map(([k, f]) => `${k}=${String(f.value)}`)
              .join(", "),
          ]),
        },
        events: {
          head: ["id", "type", "created"],
          rows: t().events.map((e) => [String(e.id), String(e.eventType), String(e.createdAt)]),
        },
      };
      const view = views[active];
      const rows = view.rows.slice(0, 200).map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`);
      const html = `<div class="inspector-section"><h2>${escapeHtml(tabs.find((x) => x.id === active)!.label)}</h2><p>API base: <a href="${escapeAttr(`${API}/dna-sequences`)}">${API}</a> (Basic auth with any API key)</p><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${view.head
        .map((h) => `<th>${escapeHtml(h)}</th>`)
        .join("")}</tr></thead><tbody>${
        rows.length
          ? rows.join("")
          : `<tr><td colspan="${view.head.length}"><div class="inspector-empty">Nothing yet</div></td></tr>`
      }</tbody></table></div></div>`;
      return c.html(renderInspectorPage("Benchling inspector", tabs, active, html, SERVICE_LABEL));
    });

    app.on("GET", "/:rest{(?!_emulate).*}", (c) => error(c, 404, "Not found"));
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, generateTenant());
  },
};

export default benchlingPlugin;
