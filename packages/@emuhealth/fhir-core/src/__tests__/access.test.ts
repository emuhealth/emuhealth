import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig, parseScopes, type FhirResource, type FhirSeedConfig } from "../index.js";

const base = "http://localhost:4100";
const redirect = "http://localhost:3000/callback";
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

const lab = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] };
const vitals = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }],
};

// Synthetic records only.
const resources: FhirResource[] = [
  { resourceType: "Practitioner", id: "dr1", name: [{ family: "Example" }] },
  { resourceType: "Patient", id: "p1", name: [{ family: "One" }] },
  { resourceType: "Patient", id: "p2", name: [{ family: "Two" }] },
  {
    resourceType: "Observation",
    id: "o1",
    status: "final",
    category: [vitals],
    code: { text: "HR" },
    subject: { reference: "Patient/p1" },
  },
  {
    resourceType: "Observation",
    id: "o1lab",
    status: "final",
    category: [lab],
    code: { text: "A1c" },
    subject: { reference: "Patient/p1" },
  },
  {
    resourceType: "Observation",
    id: "o2",
    status: "final",
    category: [vitals],
    code: { text: "HR" },
    subject: { reference: "Patient/p2" },
  },
  { resourceType: "Condition", id: "c1", code: { text: "x" }, subject: { reference: "Patient/p1" } },
];

function createApp(smart: FhirSeedConfig["smart"] = { requirePkce: false }) {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  seedFromConfig(store, base, { generate: false, resources, smart });
  return app;
}

/** Get a token through the EHR launch flow, with the patient (and practitioner) fixed by the launch. */
async function tokenFor(app: Hono, scope: string, patient = "p1"): Promise<string> {
  const launch = await app.request(
    `${base}/auth/launch?launch_uri=${encodeURIComponent("http://localhost:3000/launch")}&patient=${patient}&practitioner=dr1`,
  );
  const launchId = new URL(launch.headers.get("Location")!).searchParams.get("launch")!;
  const auth = await app.request(
    `${base}/auth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: "app",
      redirect_uri: redirect,
      aud: base,
      launch: launchId,
      scope: `launch ${scope}`,
    })}`,
  );
  const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
  const res: JsonResponse = await app.request(`${base}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: "app",
    }).toString(),
  });
  return (await res.json()).access_token;
}

function call(
  app: Hono,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/fhir+json",
) {
  return app.request(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": contentType } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Promise<JsonResponse>;
}

const ids = async (res: JsonResponse) =>
  (await res.json()).entry.map((e: { resource: FhirResource }) => `${e.resource.resourceType}/${e.resource.id}`);

describe("parseScopes", () => {
  it("reads SMART v1 and v2 resource scopes and ignores the rest", () => {
    const grants = parseScopes(
      "openid fhirUser launch patient/Observation.read user/*.write system/Patient.* patient/Condition.rs?category=problem-list-item patient/Foo.bad",
    );
    expect(grants.map((g) => `${g.context}/${g.type}.${[...g.interactions].join("")}`)).toEqual([
      "patient/Observation.rs",
      "user/*.cud",
      "system/Patient.cruds",
      "patient/Condition.rs",
    ]);
    expect(grants[3].constraints).toEqual([["category", "problem-list-item"]]);
  });
});

describe("SMART enforcement modes", () => {
  it("leaves requests without a token unrestricted by default", async () => {
    const app = createApp();
    expect((await call(app, undefined, "GET", "/Patient/p2")).status).toBe(200);
  });

  it("rejects unknown tokens with 401 and WWW-Authenticate", async () => {
    const app = createApp();
    const res = await call(app, "not-a-token", "GET", "/Patient/p1");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect((await res.json()).issue[0].code).toBe("login");
  });

  it("requires a token everywhere except discovery when fhir.smart.required is on", async () => {
    const app = createApp({ requirePkce: false, required: true });
    const res = await call(app, undefined, "GET", "/Patient/p1");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await call(app, undefined, "GET", "/metadata")).status).toBe(200);
    expect((await call(app, undefined, "GET", "/.well-known/smart-configuration")).status).toBe(200);
    expect((await call(app, undefined, "POST", "/", { resourceType: "Bundle", type: "batch", entry: [] })).status).toBe(
      401,
    );
    const token = await tokenFor(app, "patient/*.rs");
    expect((await call(app, token, "GET", "/Patient/p1")).status).toBe(200);
  });
});

describe("SMART patient scopes", () => {
  let app: Hono;
  beforeEach(() => {
    app = createApp();
  });

  it("limits reads and searches to the patient's compartment and the granted types", async () => {
    const token = await tokenFor(app, "patient/Observation.rs");
    expect(await ids(await call(app, token, "GET", "/Observation"))).toEqual(["Observation/o1", "Observation/o1lab"]);
    expect((await call(app, token, "GET", "/Observation/o1")).status).toBe(200);
    expect((await call(app, token, "GET", "/Observation/o2")).status).toBe(404);
    const noPatientScope = await call(app, token, "GET", "/Patient/p1");
    expect(noPatientScope.status).toBe(403);
    expect((await noPatientScope.json()).issue[0].code).toBe("forbidden");
    expect(
      (
        await call(app, token, "POST", "/Observation", {
          resourceType: "Observation",
          status: "final",
          code: { text: "x" },
          subject: { reference: "Patient/p1" },
        })
      ).status,
    ).toBe(403);
  });

  it("can always read the token's own fhirUser", async () => {
    const token = await tokenFor(app, "openid fhirUser patient/Observation.rs");
    expect((await call(app, token, "GET", "/Practitioner/dr1")).status).toBe(200);
    expect((await call(app, token, "GET", "/Practitioner")).status).toBe(403);
  });

  it("applies v1 read scopes to every type, history, and $everything", async () => {
    const token = await tokenFor(app, "patient/*.read");
    expect((await call(app, token, "GET", "/Patient/p1")).status).toBe(200);
    expect((await call(app, token, "GET", "/Patient/p2")).status).toBe(404);
    expect(await ids(await call(app, token, "GET", "/Patient"))).toEqual(["Patient/p1"]);
    expect((await call(app, token, "GET", "/Observation/o2/_history")).status).toBe(404);
    expect((await call(app, token, "GET", "/Observation/o2/_history/1")).status).toBe(404);
    const history = await (await call(app, token, "GET", "/_history")).json();
    expect(
      history.entry.every((e: { resource: FhirResource }) => e.resource.id !== "o2" && e.resource.id !== "p2"),
    ).toBe(true);
    expect(await ids(await call(app, token, "GET", "/Patient/p1/$everything"))).toEqual(
      expect.arrayContaining(["Patient/p1", "Observation/o1", "Condition/c1"]),
    );
    expect((await call(app, token, "GET", "/Patient/p2/$everything")).status).toBe(404);
    const typeLevel = await ids(await call(app, token, "GET", "/Patient/$everything"));
    expect(typeLevel).not.toContain("Patient/p2");
    expect(typeLevel).not.toContain("Observation/o2");
  });

  it("enforces v2 granular constraints", async () => {
    const token = await tokenFor(
      app,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
    );
    expect(await ids(await call(app, token, "GET", "/Observation"))).toEqual(["Observation/o1lab"]);
    expect((await call(app, token, "GET", "/Observation/o1")).status).toBe(404);
  });

  it("drops included resources the token may not read", async () => {
    const token = await tokenFor(app, "patient/Observation.rs");
    const bundle = await (await call(app, token, "GET", "/Observation?_include=Observation:patient")).json();
    expect(bundle.entry.filter((e: { search: { mode: string } }) => e.search.mode === "include")).toEqual([]);
    const both = await tokenFor(app, "patient/Observation.rs patient/Patient.rs");
    const withPatient = await (await call(app, both, "GET", "/Observation?_include=Observation:patient")).json();
    expect(withPatient.entry.map((e: { resource: FhirResource }) => e.resource.id)).toEqual(["o1", "o1lab", "p1"]);
  });

  it("allows writes only inside the patient's compartment", async () => {
    const token = await tokenFor(app, "patient/Observation.cruds");
    const mine = {
      resourceType: "Observation",
      status: "final",
      code: { text: "x" },
      subject: { reference: "Patient/p1" },
    };
    expect((await call(app, token, "POST", "/Observation", mine)).status).toBe(201);
    expect(
      (await call(app, token, "POST", "/Observation", { ...mine, subject: { reference: "Patient/p2" } })).status,
    ).toBe(403);
    expect(
      (await call(app, token, "PUT", "/Observation/o2", { ...mine, id: "o2", subject: { reference: "Patient/p2" } }))
        .status,
    ).toBe(403);
    expect(
      (await call(app, token, "PUT", "/Observation/o1", { ...mine, id: "o1", subject: { reference: "Patient/p2" } }))
        .status,
    ).toBe(403);
    expect((await call(app, token, "PUT", "/Observation/o1", { ...mine, id: "o1" })).status).toBe(200);
    expect(
      (
        await call(
          app,
          token,
          "PATCH",
          "/Observation/o1",
          [{ op: "replace", path: "/subject/reference", value: "Patient/p2" }],
          "application/json-patch+json",
        )
      ).status,
    ).toBe(403);
    expect((await call(app, token, "DELETE", "/Observation/o2")).status).toBe(403);
    expect((await call(app, token, "DELETE", "/Observation/o1")).status).toBe(204);
  });
});

describe("SMART user scopes", () => {
  it("are not limited to a patient, and respect interactions", async () => {
    const app = createApp();
    const token = await tokenFor(app, "openid fhirUser user/*.rs");
    expect(await ids(await call(app, token, "GET", "/Observation"))).toEqual([
      "Observation/o1",
      "Observation/o1lab",
      "Observation/o2",
    ]);
    expect((await call(app, token, "GET", "/Patient/p2")).status).toBe(200);
    expect((await call(app, token, "DELETE", "/Observation/o2")).status).toBe(403);
  });
});

describe("SMART enforcement in Bundles", () => {
  it("checks every batch entry and rolls back forbidden transactions", async () => {
    const app = createApp();
    const token = await tokenFor(app, "patient/*.cruds");
    const batch = await (
      await call(app, token, "POST", "/", {
        resourceType: "Bundle",
        type: "batch",
        entry: [
          { request: { method: "GET", url: "Patient/p1" } },
          { request: { method: "GET", url: "Patient/p2" } },
          { request: { method: "GET", url: "Observation" } },
        ],
      })
    ).json();
    expect(batch.entry.map((e: { response: { status: string } }) => e.response.status)).toEqual([
      "200 OK",
      "404 Not Found",
      "200 OK",
    ]);
    expect(batch.entry[2].resource.total).toBe(2);

    const tx = await call(app, token, "POST", "/", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          resource: { resourceType: "Condition", code: { text: "ok" }, subject: { reference: "Patient/p1" } },
          request: { method: "POST", url: "Condition" },
        },
        {
          resource: { resourceType: "Condition", code: { text: "no" }, subject: { reference: "Patient/p2" } },
          request: { method: "POST", url: "Condition" },
        },
      ],
    });
    expect(tx.status).toBe(403);
    expect((await (await call(app, undefined, "GET", "/Condition?_summary=count")).json()).total).toBe(1);
  });
});

describe("CapabilityStatement security", () => {
  it("advertises SMART-on-FHIR and the OAuth endpoints", async () => {
    const app = createApp();
    const cs = await (await call(app, undefined, "GET", "/metadata")).json();
    const security = cs.rest[0].security;
    expect(security.service[0].coding[0].code).toBe("SMART-on-FHIR");
    const uris = Object.fromEntries(
      security.extension[0].extension.map((e: { url: string; valueUri: string }) => [e.url, e.valueUri]),
    );
    expect(uris).toEqual({
      authorize: `${base}/auth/authorize`,
      token: `${base}/auth/token`,
      introspect: `${base}/auth/introspect`,
      revoke: `${base}/auth/revoke`,
    });
  });
});
