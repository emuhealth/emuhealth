import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { benchlingPlugin, generateTenant, seedFromConfig, svixSignature, type BenchlingSeedConfig } from "../index.js";

const base = "http://localhost:4107";
const KEY = `Basic ${Buffer.from("sk_synthetic_key:").toString("base64")}`;

function startService(config?: BenchlingSeedConfig) {
  const app = new Hono();
  const store = new Store();
  benchlingPlugin.register(app as never, store, new WebhookDispatcher(), base);
  benchlingPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (path: string, init: { method?: string; body?: unknown; auth?: string | null } = {}) => {
    const res = await app.request(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.auth === null ? {} : { Authorization: init.auth ?? KEY }),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

describe("Benchling API v2", () => {
  it("requires an API key or OAuth token", async () => {
    const call = startService();
    const anonymous = await call("/api/v2/dna-sequences", { auth: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.type).toBe("invalid_request_error");
    const token = await call("/api/v2/token", { method: "POST", auth: null, body: "grant_type=client_credentials" });
    expect(token.body.token_type).toBe("Bearer");
    expect((await call("/api/v2/dna-sequences", { auth: `Bearer ${token.body.access_token}` })).status).toBe(200);
    expect((await call("/api/v2/dna-sequences", { auth: "Bearer unknown" })).status).toBe(401);
  });

  it("lists, filters, and pages sequences", async () => {
    const call = startService();
    const first = await call("/api/v2/dna-sequences?pageSize=4&sort=name");
    expect(first.body.dnaSequences).toHaveLength(4);
    expect(first.body.dnaSequences[0].name).toBe("pSYN-001");
    const next = await call(`/api/v2/dna-sequences?pageSize=4&sort=name&nextToken=${first.body.nextToken}`);
    expect(next.body.dnaSequences[0].name).toBe("pSYN-005");
    const registered = await call("/api/v2/dna-sequences?entityRegistryIds.anyOf=PLS001");
    expect(registered.body.dnaSequences.map((s: any) => s.entityRegistryId)).toEqual(["PLS001"]);
    expect((await call("/api/v2/aa-sequences")).body.aaSequences).toHaveLength(5);
  });

  it("creates, updates, registers, and archives sequences", async () => {
    const call = startService();
    const created = await call("/api/v2/dna-sequences", {
      method: "POST",
      body: {
        name: "pMY-1",
        bases: "atgcatgc",
        isCircular: true,
        folderId: "lib_SYNSEQS1",
        schemaId: "ts_SYNPLSM1",
        fields: { Resistance: { value: "Kanamycin" } },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      bases: "ATGCATGC",
      length: 8,
      fields: { Resistance: { value: "Kanamycin" } },
    });
    expect((await call("/api/v2/dna-sequences", { method: "POST", body: { name: "bad", bases: "xyz" } })).status).toBe(
      400,
    );
    const updated = await call(`/api/v2/dna-sequences/${created.body.id}`, {
      method: "PATCH",
      body: { name: "pMY-2" },
    });
    expect(updated.body.name).toBe("pMY-2");
    const task = await call("/api/v2/registries/src_SYNREG01:register-entities", {
      method: "POST",
      body: { entityIds: [created.body.id], namingStrategy: "NEW_IDS" },
    });
    expect(task.status).toBe(202);
    const done = await call(`/api/v2/tasks/${task.body.taskId}`);
    expect(done.body.status).toBe("SUCCEEDED");
    expect(done.body.response.entities[0].entityRegistryId).toMatch(/^PLS\d{3}$/);
    const events = await call("/api/v2/events?eventTypes=v2.entity.registered");
    expect(events.body.events[0].entity.id).toBe(created.body.id);
    const archived = await call("/api/v2/dna-sequences:archive", {
      method: "POST",
      body: { dnaSequenceIds: [created.body.id], reason: "Made in error" },
    });
    expect(archived.body.dnaSequenceIds).toEqual([created.body.id]);
    const listed = await call("/api/v2/dna-sequences?archiveReason=Made%20in%20error");
    expect(listed.body.dnaSequences.map((s: any) => s.id)).toEqual([created.body.id]);
    await call("/api/v2/dna-sequences:unarchive", { method: "POST", body: { dnaSequenceIds: [created.body.id] } });
    expect((await call(`/api/v2/dna-sequences/${created.body.id}`)).body.archiveRecord).toBeNull();
    expect((await call("/api/v2/dna-sequences/seq_missing")).status).toBe(404);
  });

  it("creates notebook entries and assay results", async () => {
    const call = startService();
    const entry = await call("/api/v2/entries", {
      method: "POST",
      body: { name: "My experiment", folderId: "lib_SYNNOTE1" },
    });
    expect(entry.status).toBe(201);
    expect((await call(`/api/v2/entries/${entry.body.id}`)).body.entry.name).toBe("My experiment");
    const results = await call("/api/v2/assay-results", {
      method: "POST",
      body: {
        assayResults: [
          {
            schemaId: "assaysch_SYNABS1",
            projectId: "src_SYNPROJ1",
            fields: { sample: "seq_SYN00001", wavelength_nm: 600, absorbance: 0.42 },
          },
        ],
      },
    });
    expect(results.body.assayResults).toHaveLength(1);
    const fetched = await call(`/api/v2/assay-results/${results.body.assayResults[0]}`);
    expect(fetched.body.fields.absorbance.value).toBe(0.42);
    const missing = await call("/api/v2/assay-results", {
      method: "POST",
      body: {
        assayResults: [{ schemaId: "assaysch_SYNABS1", projectId: "src_SYNPROJ1", fields: { sample: "seq_SYN00001" } }],
      },
    });
    expect(missing.status).toBe(400);
    const bySample = await call("/api/v2/assay-results?schemaId=assaysch_SYNABS1&entityIds=seq_SYN00001");
    expect(bySample.body.assayResults.length).toBeGreaterThan(0);
    expect((await call("/api/v2/assay-results")).status).toBe(400);
  });

  it("delivers Svix-signed webhooks", async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const secret = `whsec_${Buffer.from("synthetic-secret").toString("base64")}`;
    try {
      const call = startService({
        webhooks: [{ url: `http://127.0.0.1:${port}/hook`, events: ["v2.entry.created"], secret }],
      });
      await call("/api/v2/entries", { method: "POST", body: { name: "Hooked", folderId: "lib_SYNNOTE1" } });
      for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(1);
      const { headers, body } = received[0];
      expect(JSON.parse(body).message.type).toBe("v2.entry.created");
      expect(headers["webhook-signature"]).toBe(
        svixSignature(secret, String(headers["webhook-id"]), String(headers["webhook-timestamp"]), body),
      );
    } finally {
      server.close();
    }
  });

  it("generates a deterministic tenant and serves an inspector", async () => {
    expect(generateTenant({ seed: 3 })).toEqual(generateTenant({ seed: 3 }));
    const call = startService();
    const page = await call("/_inspector?tab=entries", { auth: null });
    expect(page.status).toBe(200);
    expect(page.body).toContain("inspector-table");
    expect(page.body).toContain("EXP001");
  });
});
