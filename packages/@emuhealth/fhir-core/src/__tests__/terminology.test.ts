import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  fhirPlugin,
  seedFromConfig,
  generateSyntheticRecords,
  terminologyFixtures,
  type FhirResource,
  type FhirSeedConfig,
} from "../index.js";

const base = "http://localhost:4100";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };
const LOINC = "http://loinc.org";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";

function startService(config?: FhirSeedConfig) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  fhirPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${base}${path}`, { headers }) as Promise<JsonResponse>;
  return { app, get };
}

const param = (p: { parameter: Array<Record<string, unknown>> }, name: string) =>
  p.parameter.find((x) => x.name === name);

function codings(value: unknown, out: Array<{ system: string; code: string }> = []) {
  if (Array.isArray(value)) for (const v of value) codings(v, out);
  else if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.system === "string" && typeof v.code === "string" && !("value" in v && "unit" in v))
      out.push({ system: v.system, code: v.code });
    if (typeof v.system === "string" && typeof v.code === "string" && "unit" in v)
      out.push({ system: v.system, code: v.code });
    for (const child of Object.values(v)) codings(child, out);
  }
  return out;
}

describe("terminology fixtures", () => {
  it("cover every code the generator emits in the fixture code systems", () => {
    const fixtures = new Map(
      terminologyFixtures().map((cs) => [
        cs.url as string,
        new Set((cs.concept as Array<{ code: string }>).map((c) => c.code)),
      ]),
    );
    const used = codings(generateSyntheticRecords({ patients: 300, seed: 17 })).filter((c) => fixtures.has(c.system));
    expect(used.length).toBeGreaterThan(1000);
    for (const { system, code } of used) expect(fixtures.get(system)!.has(code), `${system}|${code}`).toBe(true);
  });

  it("load as tagged fragment CodeSystems that search can find", async () => {
    const { get } = startService();
    const bundle = await (await get("/CodeSystem")).json();
    expect(bundle.total).toBe(7);
    const loinc = await (await get(`/CodeSystem?url=${encodeURIComponent(LOINC)}`)).json();
    expect(loinc.total).toBe(1);
    expect(loinc.entry[0].resource).toMatchObject({
      content: "fragment",
      status: "active",
      meta: { tag: [{ code: "terminology-fixture" }] },
    });
  });

  it("can be turned off, and survive a configured population", async () => {
    expect(await (await startService({ terminology: false }).get("/CodeSystem")).json()).toMatchObject({ total: 0 });
    expect((await startService({ terminology: false }).get("/CodeSystem/emuhealth-loinc")).status).toBe(404);
    expect(await (await startService({ generate: { patients: 1 } }).get("/CodeSystem")).json()).toMatchObject({
      total: 7,
    });
    expect(() => startService({ terminology: "no" as never })).toThrow("fhir.terminology");
  });
});

describe("CodeSystem/$lookup and $validate-code", () => {
  it("looks up displays", async () => {
    const { get } = startService();
    const res = await get(`/CodeSystem/$lookup?system=${encodeURIComponent(LOINC)}&code=8867-4`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resourceType).toBe("Parameters");
    expect(param(body, "display")).toEqual({ name: "display", valueString: "Heart rate" });
    expect(param(body, "name")).toEqual({ name: "name", valueString: "LOINCSubset" });
    expect((await get(`/CodeSystem/$lookup?system=${encodeURIComponent(LOINC)}&code=0000-0`)).status).toBe(404);
    expect((await get("/CodeSystem/$lookup?system=http://example.org/unknown&code=x")).status).toBe(404);
    expect((await get("/CodeSystem/$lookup?code=x")).status).toBe(400);
  });

  it("validates codes and displays", async () => {
    const { get } = startService();
    const check = async (query: string) => (await (await get(`/CodeSystem/$validate-code?${query}`)).json()) as any;
    const ok = await check(`url=${encodeURIComponent(RXNORM)}&code=314076`);
    expect(param(ok, "result")).toEqual({ name: "result", valueBoolean: true });
    expect(param(ok, "display")!.valueString).toBe("lisinopril 10 MG Oral Tablet");
    const missing = await check(`system=${encodeURIComponent(RXNORM)}&code=999999`);
    expect(param(missing, "result")!.valueBoolean).toBe(false);
    expect(param(missing, "message")!.valueString).toContain("fragment");
    const badDisplay = await check(`url=${encodeURIComponent(RXNORM)}&code=314076&display=aspirin`);
    expect(param(badDisplay, "result")!.valueBoolean).toBe(false);
    expect(param(badDisplay, "message")!.valueString).toContain("does not match");
  });

  it("works with CodeSystems you add, including nested concepts", async () => {
    const custom: FhirResource = {
      resourceType: "CodeSystem",
      id: "local",
      url: "http://example.org/local-codes",
      name: "LocalCodes",
      status: "active",
      content: "complete",
      concept: [{ code: "parent", display: "Parent", concept: [{ code: "child", display: "Child" }] }],
    };
    const { get } = startService({ resources: [custom] });
    const body = await (await get("/CodeSystem/$lookup?system=http://example.org/local-codes&code=child")).json();
    expect(param(body, "display")!.valueString).toBe("Child");
    const invalid = await (await get("/CodeSystem/$validate-code?url=http://example.org/local-codes&code=nope")).json();
    expect(param(invalid, "message")!.valueString).not.toContain("fragment");
  });

  it("are advertised and respect token scopes", async () => {
    const { app, get } = startService({ smart: { requirePkce: false } });
    const cs = await (await get("/metadata")).json();
    const codeSystem = cs.rest[0].resource.find((r: { type: string }) => r.type === "CodeSystem");
    expect(codeSystem.operation.map((o: { name: string }) => o.name)).toEqual(["lookup", "validate-code"]);

    const auth = await app.request(
      `${base}/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "a", redirect_uri: "http://localhost:3000/cb", aud: base, scope: "user/Patient.rs" })}`,
    );
    // user/ scopes show the practitioner picker; choose the first practitioner.
    const html = await auth.text();
    const request = html.match(/name="request" value="([^"]*)"/)![1];
    const practitioner = html.match(/name="practitioner" value="([^"]*)"/)![1];
    const picked = await app.request(`${base}/auth/authorize/select`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, practitioner }).toString(),
    });
    const code = new URL(picked.headers.get("Location")!).searchParams.get("code")!;
    const token = (
      await (
        (await app.request(`${base}/auth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://localhost:3000/cb",
            client_id: "a",
          }).toString(),
        })) as JsonResponse
      ).json()
    ).access_token;
    const forbidden = await get(`/CodeSystem/$lookup?system=${encodeURIComponent(LOINC)}&code=8867-4`, {
      Authorization: `Bearer ${token}`,
    });
    expect(forbidden.status).toBe(403);
  });
});
