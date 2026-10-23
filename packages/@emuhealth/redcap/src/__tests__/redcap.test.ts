import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { DEFAULT_TOKEN, generateProject, redcapPlugin, seedFromConfig, type RedcapSeedConfig } from "../index.js";

const base = "http://localhost:4108";

function startService(config?: RedcapSeedConfig) {
  const app = new Hono();
  const store = new Store();
  redcapPlugin.register(app as never, store, new WebhookDispatcher(), base);
  redcapPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return async (fields: Record<string, string>) => {
    const res = await app.request(`${base}/api/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: DEFAULT_TOKEN, ...fields }).toString(),
    });
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, type, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
}

describe("REDCap API", () => {
  it("checks the token", async () => {
    const api = startService();
    const bad = await api({ token: "0".repeat(32), content: "version", returnFormat: "json" });
    expect(bad).toMatchObject({ status: 403, body: { error: "You do not have permissions to use the API" } });
    expect((await api({ content: "version" })).body).toBe("14.5.0");
  });

  it("exports project info, the data dictionary, instruments, and export field names", async () => {
    const api = startService();
    expect((await api({ content: "project", format: "json" })).body.project_title).toBe(
      "Synthetic Hypertension Registry",
    );
    const metadata = (await api({ content: "metadata", format: "json", "forms[0]": "visit" })).body;
    expect(metadata.every((f: { form_name: string }) => f.form_name === "visit")).toBe(true);
    expect((await api({ content: "instrument", format: "json" })).body.map((i: any) => i.instrument_name)).toEqual([
      "demographics",
      "visit",
    ]);
    const names = (await api({ content: "exportFieldNames", format: "json", field: "race" })).body;
    expect(names.map((n: any) => n.export_field_name)).toEqual([
      "race___1",
      "race___2",
      "race___3",
      "race___4",
      "race___5",
    ]);
  });

  it("exports records as json, csv, xml, labels, and eav with filters", async () => {
    const api = startService();
    const all = (await api({ content: "record", format: "json" })).body;
    expect(all).toHaveLength(20);
    expect(Object.keys(all[0])).toContain("demographics_complete");
    const some = (
      await api({ content: "record", format: "json", "records[0]": "1", "records[1]": "2", "fields[0]": "sbp" })
    ).body;
    expect(some).toEqual([
      { record_id: "1", sbp: all[0].sbp },
      { record_id: "2", sbp: all[1].sbp },
    ]);
    const high = (await api({ content: "record", format: "json", filterLogic: "[sbp] >= 140 and [sex] = '1'" })).body;
    for (const r of high) expect(Number(r.sbp) >= 140 && r.sex === "1").toBe(true);
    const labels = (await api({ content: "record", format: "json", rawOrLabel: "label", "records[0]": "1" })).body[0];
    expect(["Female", "Male"]).toContain(labels.sex);
    const csv = await api({ content: "record", format: "csv", "fields[0]": "sex" });
    expect(csv.type).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("record_id,sex");
    const xml = await api({ content: "record", "records[0]": "1" });
    expect(xml.body).toContain("<records><item><record_id><![CDATA[1]]></record_id>");
    const eav = (await api({ content: "record", format: "json", type: "eav", "records[0]": "1", "fields[0]": "sbp" }))
      .body;
    expect(eav).toEqual([{ record: "1", field_name: "sbp", value: all[0].sbp }]);
    expect((await api({ content: "record", format: "json", "fields[0]": "nope", returnFormat: "json" })).status).toBe(
      400,
    );
  });

  it("imports and deletes records", async () => {
    const api = startService();
    const imported = await api({
      content: "record",
      action: "import",
      format: "json",
      data: JSON.stringify([{ record_id: "100", sex: "2", sbp: "150", race___3: "1" }]),
    });
    expect(imported.body).toEqual({ count: 1 });
    const back = (await api({ content: "record", format: "json", "records[0]": "100" })).body[0];
    expect(back).toMatchObject({ record_id: "100", sex: "2", sbp: "150", race___3: "1", race___1: "0" });
    const invalid = await api({
      content: "record",
      action: "import",
      format: "json",
      returnFormat: "json",
      data: JSON.stringify([{ record_id: "101", sex: "9" }]),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("not a valid choice");
    const auto = await api({
      content: "record",
      action: "import",
      format: "csv",
      forceAutoNumber: "true",
      returnContent: "auto_ids",
      data: "record_id,sex\nnew,1\n",
    });
    expect(auto.body).toEqual(["101"]);
    expect((await api({ content: "generateNextRecordName" })).body).toBe("102");
    expect((await api({ content: "record", action: "delete", "records[0]": "100", "records[1]": "101" })).body).toBe(
      "2",
    );
    expect((await api({ content: "record", action: "delete", "records[0]": "100", returnFormat: "json" })).status).toBe(
      400,
    );
  });

  it("uses configured tokens and records", async () => {
    const token = "ABCDEF0123456789ABCDEF0123456789";
    const api = startService({ tokens: [token], generate: false, records: [{ record_id: "1", sex: "1" }] });
    expect((await api({ content: "version", returnFormat: "json" })).status).toBe(403);
    expect((await api({ token, content: "record", format: "json" })).body).toHaveLength(1);
    expect(() => startService({ tokens: ["short"] })).toThrow("redcap.tokens");
    expect(generateProject({ seed: 2 })).toEqual(generateProject({ seed: 2 }));
  });
});
