import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { parseVql, seedFromConfig, veevaPlugin, VqlError, type VeevaSeedConfig } from "../index.js";

const base = "http://localhost:4126";
const V = "/api/v24.3";

async function startService(config?: VeevaSeedConfig) {
  const app = new Hono();
  const store = new Store();
  veevaPlugin.register(app as never, store, new WebhookDispatcher(), base);
  veevaPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  const raw = (path: string, init?: RequestInit) => app.request(`${base}${path}`, init);
  const login = await raw(`${V}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=admin@synthetic-vault.example&password=synthetic-password",
  });
  const session = ((await login.json()) as any).sessionId as string;
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await raw(path, { ...init, headers: { Authorization: session, ...(init.headers ?? {}) } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const query = (q: string, headers: Record<string, string> = {}) =>
    req(`${V}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ q }).toString(),
    });
  return { raw, req, query, session };
}

describe("authentication", () => {
  it("issues sessions and rejects bad credentials and sessions", async () => {
    const { raw, req, session } = await startService();
    expect(session).toMatch(/^[0-9A-F]{96}$/);
    const bad = await raw(`${V}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=admin@synthetic-vault.example&password=nope",
    });
    expect(((await bad.json()) as any).errors[0].type).toBe("USERNAME_OR_PASSWORD_INCORRECT");
    const none = await raw(`${V}/vobjects/product__v`);
    expect(((await none.json()) as any).errors[0].type).toBe("INVALID_SESSION_ID");
    expect((await req(`${V}/session`, { method: "DELETE" })).body.responseStatus).toBe("SUCCESS");
    expect((await req(`${V}/vobjects/product__v`)).body.errors[0].type).toBe("INVALID_SESSION_ID");
  });

  it("lists API versions and reports unknown resources", async () => {
    const { raw, req } = await startService();
    expect(((await (await raw("/api")).json()) as any).values["v24.3"]).toBe(`${base}/api/v24.3`);
    const missing = await req(`${V}/nothing/here`);
    expect(missing.status).toBe(200);
    expect(missing.body.responseStatus).toBe("FAILURE");
    expect(missing.body.errors[0].type).toBe("MALFORMED_URL");
  });
});

describe("object records", () => {
  it("lists, retrieves, creates, upserts, updates, and deletes records", async () => {
    const { req } = await startService();
    const list = await req(`${V}/vobjects/study__v?fields=id,name__v,study_phase__v&sort=name__v desc`);
    expect(list.body.responseDetails).toMatchObject({ total: 3, offset: 0, limit: 200 });
    expect(list.body.data.map((s: any) => s.name__v)).toEqual(["EMU-303", "EMU-202", "EMU-101"]);
    expect(list.body.data[2].study_phase__v).toEqual(["phase_2__v"]);
    const one = await req(`${V}/vobjects/study__v/${list.body.data[2].id}`);
    expect(one.body.data.planned_enrollment__c).toBe(240);
    expect(one.body.responseDetails.object).toMatchObject({ name: "study__v", prefix: "0ST" });

    const created = await req(`${V}/vobjects/study__v`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { name__v: "EMU-404", study_phase__v: "phase_1__v", external_id__v: "SYN-404" },
        { name__v: "EMU-405", study_phase__v: "phase_9__v" },
        { name__v: "EMU-406", product__v: "00P000000000000" },
        { study_phase__v: "phase_1__v" },
      ]),
    });
    expect(created.body.data.map((r: any) => r.responseStatus)).toEqual(["SUCCESS", "FAILURE", "FAILURE", "FAILURE"]);
    expect(created.body.data[0].data.id).toMatch(/^0ST\d{12}$/);
    expect(created.body.data[3].errors[0].type).toBe("PARAMETER_REQUIRED");

    const csv = await req(`${V}/vobjects/study__v?idParam=external_id__v`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: 'external_id__v,name__v,planned_enrollment__c\nSYN-404,"EMU-404, renamed",12\n',
    });
    expect(csv.body.data[0].data.id).toBe(created.body.data[0].data.id);
    const updated = await req(`${V}/vobjects/study__v`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: created.body.data[0].data.id, study_status__v: "enrolling__v" }, { id: "nope" }]),
    });
    expect(updated.body.data.map((r: any) => r.responseStatus)).toEqual(["SUCCESS", "FAILURE"]);
    const after = await req(`${V}/vobjects/study__v/${created.body.data[0].data.id}`);
    expect(after.body.data).toMatchObject({
      name__v: "EMU-404, renamed",
      planned_enrollment__c: 12,
      study_status__v: ["enrolling__v"],
    });

    const del = await req(`${V}/vobjects/study__v`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: created.body.data[0].data.id }, { id: list.body.data[2].id }]),
    });
    expect(del.body.data[0].responseStatus).toBe("SUCCESS");
    expect(del.body.data[1].errors[0].type).toBe("OPERATION_NOT_ALLOWED");
  });

  it("describes objects", async () => {
    const { req } = await startService();
    const all = await req(`${V}/metadata/vobjects`);
    expect(all.body.objects.map((o: any) => o.name)).toEqual(["product__v", "country__v", "study__v", "site__v"]);
    const site = await req(`${V}/metadata/vobjects/site__v`);
    expect(site.body.object.fields.find((f: any) => f.name === "study__v")).toMatchObject({
      type: "Object",
      required: true,
      relationship_name: "study__vr",
    });
  });
});

describe("documents", () => {
  it("lists, retrieves, downloads, creates, updates, and deletes documents", async () => {
    const { raw, req, session } = await startService();
    const list = await req(`${V}/objects/documents?search=protocol`);
    expect(list.body.size).toBe(3);
    const doc = list.body.documents[0].document;
    expect(doc).toMatchObject({ id: 1, status__v: "Approved", major_version_number__v: 1, version_id: "1_1_0" });
    const one = await req(`${V}/objects/documents/1`);
    expect(one.body.versions).toEqual([{ number: "1.0", value: `${base}${V}/objects/documents/1/versions/1/0` }]);
    const file = await raw(`${V}/objects/documents/1/file`, { headers: { Authorization: session } });
    expect(await file.text()).toContain("SYNTHETIC DOCUMENT");

    const form = new FormData();
    form.set("name__v", "Synthetic Monitoring Plan");
    form.set("type__v", "Trial Master File");
    form.set("lifecycle__v", "General Lifecycle");
    form.set("file", new Blob(["synthetic plan"], { type: "text/plain" }), "plan.txt");
    const created = await req(`${V}/objects/documents`, { method: "POST", body: form });
    expect(created.body).toMatchObject({
      responseStatus: "SUCCESS",
      responseMessage: "successfully created document",
      id: 10,
    });
    const fetched = await req(`${V}/objects/documents/10`);
    expect(fetched.body.document).toMatchObject({ status__v: "Draft", filename__v: "plan.txt", size__v: 14 });

    const update = new URLSearchParams({ title__v: "Monitoring Plan v2" });
    await req(`${V}/objects/documents/10`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: update.toString(),
    });
    expect((await req(`${V}/objects/documents/10`)).body.document.title__v).toBe("Monitoring Plan v2");
    const missing = new FormData();
    missing.set("name__v", "No type");
    expect((await req(`${V}/objects/documents`, { method: "POST", body: missing })).body.responseStatus).toBe(
      "FAILURE",
    );
    expect((await req(`${V}/objects/documents/10`, { method: "DELETE" })).body.id).toBe(10);
  });
});

describe("VQL", () => {
  it("parses the supported grammar", () => {
    const q = parseVql(
      "SELECT id, name__v FROM study__v WHERE (name__v LIKE 'EMU%' AND NOT planned_enrollment__c < 100) OR id IN ('a','b') ORDER BY name__v DESC PAGESIZE 5",
    );
    expect(q).toMatchObject({ target: "study__v", pageSize: 5, orderBy: [{ field: "name__v", desc: true }] });
    expect(() => parseVql("SELECT FROM x")).toThrow(VqlError);
  });

  it("queries objects and documents with relationships, filters, and paging", async () => {
    const { req, query } = await startService();
    const res = await query(
      "SELECT id, name__v, study__vr.name__v, country__vr.abbreviation__c FROM site__v WHERE site_status__v = 'active__v' AND study__vr.name__v = 'EMU-101' ORDER BY name__v",
      { "X-VaultAPI-DescribeQuery": "true" },
    );
    expect(res.body.responseDetails).toMatchObject({ size: 2, total: 2, pageoffset: 0 });
    expect(res.body.data[0]).toMatchObject({
      name__v: "EMU-101-001",
      "study__vr.name__v": "EMU-101",
      "country__vr.abbreviation__c": "US",
    });
    expect(res.body.queryDescribe.object.name).toBe("site__v");

    const paged = await query("SELECT id FROM documents ORDER BY id PAGESIZE 4");
    expect(paged.body.responseDetails.next_page).toMatch(/^\/api\/v24\.3\/query\/[0-9a-f-]+\?pagesize=4&pageoffset=4$/);
    const next = await req(paged.body.responseDetails.next_page);
    expect(next.body.data.map((d: any) => d.id)).toEqual([5, 6, 7, 8]);

    const docs = await query(
      "SELECT id, name__v FROM documents WHERE status__v = 'Draft' AND study__vr.name__v CONTAINS ('EMU-202')",
    );
    expect(docs.body.data).toHaveLength(1);
    expect((await query("SELECT id FROM nope__v")).body.errors[0].type).toBe("INVALID_DATA");
    expect((await query("SELEKT id FROM study__v")).body.errors[0].type).toBe("INCORRECT_QUERY_SYNTAX_ERROR");
  });
});
