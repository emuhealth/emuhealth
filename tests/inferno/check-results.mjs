// Summarizes `inferno execute --outputter json` results and fails when any required test fails or errors.
// Skipped and omitted tests are reported but allowed: they mean the synthetic data has no resources of that kind.
// Unfinished tests (wait, running, cancel) and runs with fewer than --min tests also fail, so a script that stalls
// cannot pass.
// Usage: node tests/inferno/check-results.mjs results.json [--min <tests>]
// Tests listed in exceptions.json, by the last part of their id, are reported with the reason instead of failing.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const minIndex = process.argv.indexOf("--min");
const min = minIndex === -1 ? 1 : Number(process.argv[minIndex + 1]);
if (!file) throw new Error("Usage: check-results.mjs <results.json>");
const text = readFileSync(file, "utf8");
const results = JSON.parse(text.slice(text.indexOf("[")));

const tests = results.filter((r) => r.test_id);
const counts = {};
for (const r of tests) counts[r.result] = (counts[r.result] ?? 0) + 1;
console.log(
  `Inferno tests: ${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}`,
);

const exceptions = JSON.parse(readFileSync(new URL("./exceptions.json", import.meta.url), "utf8"));
const name = (id) => id.split("-").slice(-1)[0];
const failed = (r) => r.result === "fail" || r.result === "error";
const excepted = tests.filter((r) => failed(r) && name(r.test_id) in exceptions);
const failing = tests.filter((r) => failed(r) && !r.optional && !(name(r.test_id) in exceptions));
const optionalFailing = tests.filter((r) => failed(r) && r.optional && !(name(r.test_id) in exceptions));
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
if (excepted.length > 0) {
  console.log(`\nKnown exceptions (${excepted.length}):`);
  for (const r of excepted)
    console.log(`  ${r.result.toUpperCase()} ${name(r.test_id)}: ${exceptions[name(r.test_id)]}`);
}
report("Optional tests that failed", optionalFailing);
report("Skipped or omitted", skipped);

const unfinished = tests.filter((r) => ["wait", "running", "queued", "cancel"].includes(r.result));
report("Unfinished", unfinished);
if (tests.length < min) {
  console.error(`\nOnly ${tests.length} test results, expected at least ${min}`);
  process.exit(1);
}
process.exit(failing.length > 0 || unfinished.length > 0 ? 1 : 0);
