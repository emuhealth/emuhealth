// Saves what a running emuhealth FHIR service serves, one JSON file per resource, for the HL7 FHIR Validator:
// the CapabilityStatement, every resource of every supported type, one search Bundle, and one $everything Bundle.
// Usage: node tests/fhir-validator/export.mjs <baseUrl> <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base = "http://localhost:4100", out = "fhir-out"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

// FHIR_TOKEN, when set, is sent as a bearer token (for servers that require one, such as the payer emulator).
const auth = process.env.FHIR_TOKEN ? { Authorization: `Bearer ${process.env.FHIR_TOKEN}` } : {};

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/fhir+json", ...auth } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}: ${await res.text()}`);
  return res.json();
}
const save = (name, resource) => writeFileSync(join(out, `${name}.json`), JSON.stringify(resource, null, 2));

const metadata = await get(`${base}/metadata`);
save("CapabilityStatement-metadata", metadata);

let count = 1;
let firstPatient;
for (const { type } of metadata.rest?.[0]?.resource ?? []) {
  let url = `${base}/${type}?_count=200`;
  let first = true;
  while (url) {
    const bundle = await get(url);
    if (first && bundle.entry?.length) save(`Bundle-search-${type}`, bundle);
    first = false;
    for (const { resource } of bundle.entry ?? []) {
      if (resource.resourceType !== type) continue;
      save(`${type}-${resource.id}`, resource);
      if (type === "Patient") firstPatient ??= resource.id;
      count++;
    }
    url = bundle.link?.find((l) => l.relation === "next")?.url;
  }
}
if (firstPatient) save("Bundle-everything", await get(`${base}/Patient/${firstPatient}/$everything`));
console.log(`Saved ${count} resources from ${base} to ${out}`);
