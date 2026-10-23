// Summarizes `inferno execute --outputter json` results and fails when any required test fails or errors.
// Skipped and omitted tests are reported but allowed: they mean the synthetic data has no resources of that kind.
// Usage: node tests/inferno/check-results.mjs results.json
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: check-results.mjs <results.json>");
const text = readFileSync(file, "utf8");
const results = JSON.parse(text.slice(text.indexOf("[")));

const tests = results.filter((r) => r.test_id);
const counts = {};
for (const r of tests) counts[r.result] = (counts[r.result] ?? 0) + 1;
console.log(`Inferno tests: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);

const name = (id) => id.split("-").slice(-1)[0];
const failing = tests.filter((r) => (r.result === "fail" || r.result === "error") && !r.optional);
const optionalFailing = tests.filter((r) => (r.result === "fail" || r.result === "error") && r.optional);
const skipped = tests.filter((r) => r.result === "skip" || r.result === "omit");

const report = (title, list) => {
  if (list.length === 0) return;
  console.log(`\n${title} (${list.length}):`);
  for (const r of list) {
    console.log(`  ${r.result.toUpperCase()} ${name(r.test_id)}: ${r.result_message ?? ""}`);
    for (const m of (r.messages ?? []).filter((m) => m.type === "error").slice(0, 5))
      console.log(`      ${m.message.slice(0, 300)}`);
  }
};
report("Required tests that failed", failing);
report("Optional tests that failed", optionalFailing);
report("Skipped or omitted", skipped);

if (tests.length === 0) {
  console.error("No test results found");
  process.exit(1);
}
process.exit(failing.length > 0 ? 1 : 0);
