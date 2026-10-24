import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { fhirPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4100";
const NPI = "http://hl7.org/fhir/sid/us-npi";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

// A hand-written fixture in the shape Synthea writes: a hospital Bundle with conditional creates, and a patient
// transaction with urn:uuid fullUrls and conditional references to the hospital's resources.
function syntheaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "synthea-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "Example123_Patient_abc.json"),
    JSON.stringify({
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          fullUrl: "urn:uuid:p1",
          resource: { resourceType: "Patient", name: [{ family: "Imported", given: ["Synthea"] }], gender: "female" },
          request: { method: "POST", url: "Patient" },
        },
        {
          fullUrl: "urn:uuid:e1",
          resource: {
            resourceType: "Encounter",
            status: "finished",
            class: { code: "AMB" },
            subject: { reference: "urn:uuid:p1" },
            participant: [{ individual: { reference: `Practitioner?identifier=${NPI}|9999999901` } }],
            serviceProvider: { reference: "Organization?identifier=https://github.com/synthetichealth/synthea|org-1" },
          },
          request: { method: "POST", url: "Encounter" },
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "hospitalInformation1.json"),
    JSON.stringify({
      resourceType: "Bundle",
      type: "batch",
      entry: [
        {
          resource: {
            resourceType: "Organization",
            identifier: [{ system: "https://github.com/synthetichealth/synthea", value: "org-1" }],
            name: "Synthetic General",
          },
          request: {
            method: "POST",
            url: "Organization",
            ifNoneExist: "identifier=https://github.com/synthetichealth/synthea|org-1",
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "practitionerInformation1.json"),
    JSON.stringify({
      resourceType: "Bundle",
      type: "batch",
      entry: [
        {
          resource: {
            resourceType: "Practitioner",
            identifier: [{ system: NPI, value: "9999999901" }],
            name: [{ family: "Doc" }],
          },
          request: { method: "POST", url: "Practitioner", ifNoneExist: `identifier=${NPI}|9999999901` },
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "Observation.ndjson"),
    [
      { resourceType: "Observation", id: "nd-1", status: "final", code: { text: "One" } },
      { resourceType: "Observation", id: "nd-2", status: "final", code: { text: "Two" } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  return dir;
}

function start() {
  const app = new Hono();
  const store = new Store();
  fhirPlugin.register(app as never, store, new WebhookDispatcher(), base);
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`${base}${path}`, { ...init, headers: { "Content-Type": "application/fhir+json" } });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { store, req };
}

describe("fhir.import", () => {
  it("loads Synthea style output, resolving conditional references after the hospital files", async () => {
    const { store, req } = start();
    seedFromConfig(store, base, { generate: false, import: syntheaDir() });
    const patients = await req("/Patient?family=Imported");
    expect(patients.body.total).toBe(1);
    const encounter = (await req(`/Encounter?patient=${patients.body.entry[0].resource.id}`)).body.entry[0].resource;
    const practitioner = (await req(`/Practitioner?identifier=${NPI}|9999999901`)).body.entry[0].resource;
    expect(encounter.participant[0].individual.reference).toBe(`Practitioner/${practitioner.id}`);
    expect(encounter.serviceProvider.reference).toMatch(/^Organization\//);
    expect((await req("/Observation/nd-2")).body.code.text).toBe("Two");
  });

  it("reports the file of a failed import and rejects bad config", () => {
    const { store } = start();
    const dir = syntheaDir();
    rmSync(join(dir, "practitionerInformation1.json"));
    expect(() => seedFromConfig(store, base, { generate: false, import: dir })).toThrow(
      /Example123_Patient_abc\.json.*Practitioner\?identifier/,
    );
    expect(() => seedFromConfig(store, base, { import: [1] as never })).toThrow(
      "fhir.import must be a path or an array of paths",
    );
  });

  it("fails a transaction whose conditional reference does not match exactly one resource", async () => {
    const { req } = start();
    const res = await req("/", {
      method: "POST",
      body: JSON.stringify({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            resource: {
              resourceType: "Observation",
              status: "final",
              code: { text: "x" },
              subject: { reference: "Patient?identifier=none|1" },
            },
            request: { method: "POST", url: "Observation" },
          },
        ],
      }),
    });
    expect(res.status).toBe(412);
  });
});
