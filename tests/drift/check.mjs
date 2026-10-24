// Contract drift check: compares upstream releases with what emuhealth emulates, pins, or last reviewed, and fails
// when something new needs a look. Run weekly by .github/workflows/drift.yml; it only reads public metadata.
// Usage: node tests/drift/check.mjs [--update]  (--update records the current upstream versions as reviewed)
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const baselineUrl = new URL("./baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineUrl, "utf8"));
const github = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

async function json(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.json();
}
const text = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.text();
};
const githubRelease = async (repo) =>
  (await json(`https://api.github.com/repos/${repo}/releases/latest`, github)).tag_name;
const pypi = async (name) => (await json(`https://pypi.org/pypi/${name}/json`)).info.version;
const fhirPackage = async (name) => (await json(`https://packages.fhir.org/${name}`))["dist-tags"].latest;
const pinned = (file, pattern) => read(file).match(pattern)?.[1];

// Each check reports the latest upstream version and, where it applies, what the repo pins or emulates.
const checks = [
  {
    name: "HL7 FHIR Validator",
    latest: () => githubRelease("hapifhir/org.hl7.fhir.core"),
    current: () => pinned(".github/workflows/fhir-validator.yml", /VALIDATOR_VERSION: (\S+)/),
  },
  {
    name: "Inferno US Core test kit",
    latest: () => githubRelease("inferno-framework/us-core-test-kit"),
    current: () => pinned(".github/workflows/inferno.yml", /US_CORE_TEST_KIT_REF: (\S+)/),
  },
  { name: "US Core", latest: () => fhirPackage("hl7.fhir.us.core") },
  { name: "SMART App Launch", latest: () => fhirPackage("hl7.fhir.uv.smart-app-launch") },
  { name: "FHIR R5 core", latest: () => fhirPackage("hl7.fhir.r5.core") },
  {
    name: "Vault API (VAPIL)",
    latest: async () =>
      (
        await text(
          "https://raw.githubusercontent.com/veeva/vault-api-library/main/src/main/java/com/veeva/vault/vapil/api/client/VaultClient.java",
        )
      ).match(/VAULT_API_VERSION = "(v[\d.]+)"/)[1],
    // The emulator must list the version current clients ask for in GET /api.
    emulated: () => read("packages/@emuhealth/veeva/src/index.ts").match(/const VERSIONS = \[([^\]]+)\]/)[1],
  },
  {
    name: "VAPIL",
    latest: async () =>
      (await text("https://veeva.github.io/vault-api-library/maven/com/veeva/vault/vapil/maven-metadata.xml")).match(
        /<release>([^<]+)<\/release>/,
      )[1],
    current: () =>
      pinned("tests/clients/veeva-vapil/pom.xml", /<vapil.version>([^<]+)</) ??
      pinned("tests/clients/veeva-vapil/pom.xml", /<artifactId>vapil<\/artifactId>\s*<version>([^<$]+)</),
  },
  ...["rwslib", "fhirclient", "dicomweb-client", "hl7", "pydicom"].map((name) => ({
    name: `${name} (PyPI)`,
    latest: () => pypi(name),
    current: () => pinned("tests/clients/requirements.txt", new RegExp(`^${name}==(\\S+)`, "m")),
  })),
];

const rows = [];
let drift = 0;
for (const check of checks) {
  try {
    const latest = await check.latest();
    const current = check.current?.();
    const reviewed = baseline[check.name];
    const problems = [];
    if (check.emulated && !check.emulated().includes(`"${latest}"`)) problems.push(`emulator does not list ${latest}`);
    if (reviewed !== latest) problems.push(reviewed ? `new since review (${reviewed})` : "not reviewed yet");
    if (problems.length) drift++;
    rows.push({ name: check.name, latest, current: current ?? "", status: problems.join("; ") || "ok" });
  } catch (error) {
    drift++;
    rows.push({ name: check.name, latest: "?", current: "", status: `check failed: ${error.message}` });
  }
}

const table = [
  "| Upstream | Latest | Pinned here | Status |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.name} | ${r.latest} | ${r.current} | ${r.status} |`),
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Contract drift\n\n${table}\n`, { flag: "a" });

if (process.argv.includes("--update")) {
  const next = Object.fromEntries(rows.filter((r) => r.latest !== "?").map((r) => [r.name, r.latest]));
  writeFileSync(baselineUrl, JSON.stringify(next, null, 2) + "\n");
  console.log("\nRecorded the latest versions as reviewed in tests/drift/baseline.json.");
} else if (drift) {
  console.error(`\n${drift} item(s) need review. Update the emulators, pins, or docs, then run with --update.`);
  process.exit(1);
}
