import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

function createAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function createInstallationToken(url: string, appId: string, installationId: number, privateKey: string) {
  return fetch(`${url}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${createAppJwt(appId, privateKey)}` },
  });
}

describe("createEmulator", () => {
  // First test in the file: it pays the cold import of the GitHub emulator, which can exceed 5s on busy CI runners.
  it("starts github and returns a url", { timeout: 20_000 }, async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts multiple services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");
    expect(vercel.generatedSecrets).toEqual([]);

    await Promise.all([github.close(), vercel.close()]);
  });

  it("starts the Epic emulator under Epic's FHIR base", async () => {
    const epic = await createEmulator({ service: "epic", port: 14020 });
    const res = await fetch(`${epic.url}/api/FHIR/R4/Patient/syn-patient-001`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("syn-patient-001");
    await epic.close();
  });

  it("starts the openFDA emulator with synthetic labels", async () => {
    const openfda = await createEmulator({ service: "openfda", port: 14021 });
    const res = await fetch(`${openfda.url}/drug/label.json?search=openfda.generic_name:metformin`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { results: { total: number } } };
    expect(body.meta.results.total).toBe(1);
    await openfda.close();
  });

  it("starts the RxNav emulator with the RxNorm subset", async () => {
    const rxnav = await createEmulator({ service: "rxnav", port: 14022 });
    const res = await fetch(`${rxnav.url}/REST/rxcui.json?name=lisinopril`);
    expect(((await res.json()) as { idGroup: { rxnormId: string[] } }).idGroup.rxnormId).toEqual(["29046"]);
    await rxnav.close();
  });

  it("starts the ClinicalTrials.gov emulator with synthetic studies", async () => {
    const ct = await createEmulator({ service: "clinicaltrials", port: 14023 });
    const res = await fetch(`${ct.url}/api/v2/studies/NCT99000001`);
    expect(res.status).toBe(200);
    await ct.close();
  });

  it("starts the NCBI E-utilities emulator", async () => {
    const ncbi = await createEmulator({ service: "ncbi", port: 14024 });
    const res = await fetch(`${ncbi.url}/entrez/eutils/esearch.fcgi?db=gene&term=BRCA1[sym]&retmode=json`);
    expect(((await res.json()) as { esearchresult: { idlist: string[] } }).esearchresult.idlist).toEqual(["672"]);
    await ncbi.close();
  });

  it("starts the NPPES NPI Registry emulator", async () => {
    const nppes = await createEmulator({ service: "nppes", port: 14025 });
    const res = await fetch(`${nppes.url}/api/?version=2.1&city=springfield&limit=1`);
    expect(((await res.json()) as { result_count: number }).result_count).toBe(1);
    await nppes.close();
  });

  it("starts the Benchling emulator behind API key auth", async () => {
    const benchling = await createEmulator({ service: "benchling", port: 14026 });
    expect((await fetch(`${benchling.url}/api/v2/dna-sequences`)).status).toBe(401);
    const res = await fetch(`${benchling.url}/api/v2/dna-sequences`, {
      headers: { Authorization: `Basic ${Buffer.from("sk_test:").toString("base64")}` },
    });
    expect(res.status).toBe(200);
    await benchling.close();
  });

  it("starts the REDCap emulator", async () => {
    const redcap = await createEmulator({ service: "redcap", port: 14027 });
    const res = await fetch(`${redcap.url}/api/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=5E7E0000000000000000000000000001&content=record&format=json",
    });
    expect(((await res.json()) as unknown[]).length).toBe(20);
    await redcap.close();
  });

  it("starts the Oracle Health emulator under the tenant path", async () => {
    const cerner = await createEmulator({ service: "cerner", port: 14028 });
    const res = await fetch(`${cerner.url}/r4/5e7e0000-0000-4000-8000-000000000001/Patient/syn-patient-001`);
    expect(res.status).toBe(200);
    await cerner.close();
  });

  it("starts the athenahealth emulator behind client credentials", async () => {
    const athena = await createEmulator({ service: "athena", port: 14029 });
    const token = await fetch(`${athena.url}/oauth2/v1/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("a:b").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const { access_token } = (await token.json()) as { access_token: string };
    const res = await fetch(`${athena.url}/v1/195900/patients/1`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(200);
    await athena.close();
  });

  it("starts the Blue Button emulator with token-only FHIR", async () => {
    const bb = await createEmulator({ service: "bluebutton", port: 14030 });
    expect((await fetch(`${bb.url}/v2/fhir/metadata`)).status).toBe(200);
    expect((await fetch(`${bb.url}/v2/fhir/Patient/syn-patient-001`)).status).toBe(401);
    await bb.close();
  });

  it("starts the CDS Hooks emulator with sample services", async () => {
    const cds = await createEmulator({ service: "cdshooks", port: 14031 });
    const res = await fetch(`${cds.url}/cds-services`);
    expect(((await res.json()) as { services: unknown[] }).services).toHaveLength(2);
    await cds.close();
  });

  it("starts the Redox emulator", async () => {
    const redox = await createEmulator({ service: "redox", port: 14032 });
    const res = await fetch(`${redox.url}/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "k", secret: "s" }),
    });
    expect(res.status).toBe(200);
    await redox.close();
  });

  it("starts the HealthLake emulator and keeps its datastore across reset", async () => {
    const healthlake = await createEmulator({ service: "healthlake", port: 14033 });
    const unsigned = await fetch(`${healthlake.url}/datastore/5e7e0000000000000000000000000001/r4/Patient`);
    expect(unsigned.status).toBe(403);
    healthlake.reset();
    const inspector = await fetch(`${healthlake.url}/_inspector`);
    expect(await inspector.text()).toContain("5e7e0000000000000000000000000001");
    await healthlake.close();
  });

  it("starts the Cloud Healthcare emulator with a default FHIR store", async () => {
    const gcp = await createEmulator({ service: "gcphealthcare", port: 14034 });
    const res = await fetch(
      `${gcp.url}/v1/projects/synthetic-project/locations/us-central1/datasets/synthetic-dataset/fhirStores/synthetic-fhir-store/fhir/Patient/syn-patient-001`,
      { headers: { Authorization: "Bearer test" } },
    );
    expect(res.status).toBe(200);
    await gcp.close();
  });

  it("starts the Azure Health Data Services emulator", async () => {
    const azure = await createEmulator({ service: "azurehealth", port: 14035 });
    expect((await fetch(`${azure.url}/synthetic-fhir/Patient`)).status).toBe(401);
    const res = await fetch(`${azure.url}/synthetic-fhir/Patient/syn-patient-001`, {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    await azure.close();
  });

  it("starts the Stedi emulator", async () => {
    const stedi = await createEmulator({ service: "stedi", port: 14036 });
    const res = await fetch(`${stedi.url}/2024-04-01/payers`, { headers: { Authorization: "test_key" } });
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(2);
    await stedi.close();
  });

  it("starts the Availity emulator", async () => {
    const availity = await createEmulator({ service: "availity", port: 14037 });
    const res = await fetch(`${availity.url}/availity/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=a&client_secret=b",
    });
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(300);
    await availity.close();
  });

  it("starts the Dexcom emulator", async () => {
    const dexcom = await createEmulator({ service: "dexcom", port: 14038 });
    const login = await fetch(
      `${dexcom.url}/v2/oauth2/login?client_id=a&redirect_uri=http://localhost:3000/cb&response_type=code`,
    );
    expect(await login.text()).toContain("Sign in to Dexcom");
    expect((await fetch(`${dexcom.url}/v3/users/self/devices`)).status).toBe(401);
    await dexcom.close();
  });

  it("reset wipes and re-seeds stores", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("generates a GitHub App key once and keeps it across reset", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14040,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          orgs: [{ login: "acme" }],
          repos: [{ owner: "acme", name: "private-repo", private: true }],
          apps: [
            {
              app_id: 900,
              slug: "generated-key-app",
              name: "Generated Key App",
              installations: [{ installation_id: 901, account: "acme" }],
            },
          ],
        },
      },
    });

    expect(github.generatedSecrets).toHaveLength(1);
    expect(github.generatedSecrets[0]).toMatchObject({
      service: "github",
      kind: "github.app_private_key",
      id: "900",
      label: "Generated Key App",
    });
    const privateKey = github.generatedSecrets[0]!.value;
    expect(privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    const firstToken = await createInstallationToken(github.url, "900", 901, privateKey);
    expect(firstToken.status).toBe(201);
    const firstTokenValue = ((await firstToken.json()) as { token: string }).token;
    expect(firstTokenValue).toMatch(/^ghs_/);
    expect(await (await fetch(`${github.url}/_emulate/installation-tokens`)).json()).toMatchObject({
      installation_tokens: [expect.objectContaining({ installation: { id: 901 }, status: "active" })],
    });
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${firstTokenValue}` },
        })
      ).status,
    ).toBe(200);

    github.reset();

    expect(await (await fetch(`${github.url}/_emulate/installation-tokens`)).json()).toEqual({
      installation_tokens: [],
    });
    const resetTokenUser = await fetch(`${github.url}/user`, {
      headers: { Authorization: `Bearer ${firstTokenValue}` },
    });
    expect(resetTokenUser.status).toBe(200);
    expect(await resetTokenUser.json()).toMatchObject({ login: "octocat", type: "User" });
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${firstTokenValue}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${github.url}/user`, {
          headers: { Authorization: "Bearer test_token_admin" },
        })
      ).status,
    ).toBe(200);

    const tokenAfterReset = await createInstallationToken(github.url, "900", 901, privateKey);
    expect(tokenAfterReset.status).toBe(201);
    const tokenAfterResetValue = ((await tokenAfterReset.json()) as { token: string }).token;
    expect(tokenAfterResetValue).toMatch(/^ghs_/);
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${tokenAfterResetValue}` },
        })
      ).status,
    ).toBe(200);
    expect(github.generatedSecrets[0]!.value).toBe(privateKey);

    await github.close();
  });

  it("uses an explicit GitHub App key without exposing it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const github = await createEmulator({
      service: "github",
      port: 14041,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          apps: [
            {
              app_id: 910,
              slug: "explicit-key-app",
              name: "Explicit Key App",
              private_key: privateKey,
              installations: [{ installation_id: 911, account: "octocat" }],
            },
          ],
        },
      },
    });

    expect(github.generatedSecrets).toEqual([]);
    const token = await createInstallationToken(github.url, "910", 911, privateKey);
    expect(token.status).toBe(201);

    await github.close();
  });

  it("rejects a JWT signed with the wrong GitHub App key", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14042,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          apps: [
            {
              app_id: 920,
              slug: "wrong-key-app",
              name: "Wrong Key App",
              installations: [{ installation_id: 921, account: "octocat" }],
            },
          ],
        },
      },
    });
    const { privateKey: wrongKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });

    const response = await createInstallationToken(github.url, "920", 921, wrongKey);
    expect(response.status).toBe(401);

    await github.close();
  });

  it("rejects an empty explicit GitHub App key", async () => {
    await expect(
      createEmulator({
        service: "github",
        port: 14043,
        seed: {
          github: {
            apps: [{ app_id: 930, slug: "empty-key-app", name: "Empty Key App", private_key: "" }],
          },
        },
      }),
    ).rejects.toThrow('GitHub App "empty-key-app" private_key must not be empty');
  });

  it.each([
    {
      name: "app ID",
      apps: [
        { app_id: 940, slug: "first-app", name: "First App" },
        { app_id: 940, slug: "second-app", name: "Second App" },
      ],
      message: "Duplicate GitHub App app_id: 940",
    },
    {
      name: "slug",
      apps: [
        { app_id: 950, slug: "duplicate-app", name: "First App" },
        { app_id: 951, slug: "duplicate-app", name: "Second App" },
      ],
      message: 'Duplicate GitHub App slug: "duplicate-app"',
    },
  ])("rejects a duplicate GitHub App $name before startup", async ({ apps, message }) => {
    await expect(
      createEmulator({
        service: "github",
        port: 14044,
        seed: { github: { apps } },
      }),
    ).rejects.toThrow(message);

    await expect(fetch("http://localhost:14044/user")).rejects.toThrow();
  });

  it("does not grant Slack fallback scopes in strict mode", async () => {
    const slack = await createEmulator({
      service: "slack",
      port: 14030,
      seed: { slack: { strict_scopes: true } },
    });

    const res = await fetch(`${slack.url}/api/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: "Bearer arbitrary-slack-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "C000000001", text: "strict fallback" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string; needed: string; provided: string };
    expect(body).toMatchObject({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
      provided: "",
    });

    await slack.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
