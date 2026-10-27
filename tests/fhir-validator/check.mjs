// Summarizes HL7 FHIR Validator output (`-output results.json`) and fails on any error or fatal issue that
// exceptions.json does not explain. Warnings and information are counted but allowed.
// Usage: node tests/fhir-validator/check.mjs results.json [--min <files>] [--exceptions <extra.json>]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const minIndex = process.argv.indexOf("--min");
const min = minIndex === -1 ? 1 : Number(process.argv[minIndex + 1]);
if (!file) throw new Error("Usage: check.mjs <results.json>");

const results = JSON.parse(readFileSync(file, "utf8"));
const outcomes = results.resourceType === "Bundle" ? (results.entry ?? []).map((e) => e.resource) : [results];
const FILE_EXT = "http://hl7.org/fhir/StructureDefinition/operationoutcome-file";
const fileOf = (o) => o.extension?.find((e) => e.url === FILE_EXT)?.valueString ?? "(unknown file)";

const extraIndex = process.argv.indexOf("--exceptions");
const exceptionFiles = [new URL("./exceptions.json", import.meta.url)];
if (extraIndex !== -1) exceptionFiles.push(new URL(process.argv[extraIndex + 1], `file://${process.cwd()}/`));
const exceptions = exceptionFiles.flatMap((f) => Object.entries(JSON.parse(readFileSync(f, "utf8"))));
const exception = (text) => exceptions.find(([pattern]) => new RegExp(pattern).test(text))?.[1];

const severities = {};
const failing = new Map();
const excepted = new Map();
for (const outcome of outcomes) {
  for (const issue of outcome.issue ?? []) {
    severities[issue.severity] = (severities[issue.severity] ?? 0) + 1;
    if (issue.severity !== "error" && issue.severity !== "fatal") continue;
    const text = issue.details?.text ?? issue.diagnostics ?? "";
    const where = `${fileOf(outcome)} ${(issue.expression ?? issue.location ?? []).join(", ")}`;
    const reason = exception(text);
    const bucket = reason ? excepted : failing;
    const key = reason ?? text;
    const entry = bucket.get(key) ?? { count: 0, example: where, text };
    entry.count++;
    bucket.set(key, entry);
  }
}

console.log(
  `Validated ${outcomes.length} files: ${
    Object.entries(severities)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "no issues"
  }`,
);
if (excepted.size > 0) {
  console.log(`\nKnown exceptions (${excepted.size}):`);
  for (const [reason, e] of excepted) console.log(`  ${e.count}x ${reason}`);
}
if (failing.size > 0) {
  console.log(`\nErrors (${failing.size} distinct):`);
  for (const [, e] of [...failing].sort((a, b) => b[1].count - a[1].count))
    console.log(`  ${e.count}x ${e.text.slice(0, 400)}\n      first at ${e.example}`);
}
if (outcomes.length < min) {
  console.error(`\nOnly ${outcomes.length} files validated, expected at least ${min}`);
  process.exit(1);
}
process.exit(failing.size > 0 ? 1 : 0);
