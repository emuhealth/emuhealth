import type { Store } from "@emulators/core";
import { generatorTerminology } from "./generator.js";
import { FhirError } from "./outcome.js";
import { getFhirStore, type FhirResource, type FhirStore } from "./store.js";

// Terminology fixtures (decision 0004): small subsets of license-free code systems, plus the few LOINC codes the
// generator uses, as CodeSystem resources with $lookup and $validate-code.

export const TERMINOLOGY_TAG = {
  system: "urn:emuhealth:tag",
  code: "terminology-fixture",
  display: "Terminology fixture",
};

const slug = (name: string) =>
  name
    .replace(/Subset$/, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();

/** The fixture CodeSystems. Content is "fragment": only the codes emuhealth uses, not the full code system. */
export function terminologyFixtures(): FhirResource[] {
  return generatorTerminology().map((subset) => ({
    resourceType: "CodeSystem",
    id: `emuhealth-${slug(subset.name)}`,
    meta: { tag: [TERMINOLOGY_TAG] },
    url: subset.system,
    name: subset.name,
    title: subset.title,
    status: "active",
    experimental: false,
    publisher: "emuhealth",
    description: `The ${subset.concepts.length} codes emuhealth uses from this code system, for local development. This is not the full code system.`,
    caseSensitive: true,
    content: "fragment",
    count: subset.concepts.length,
    concept: subset.concepts.map(({ code, display }) => ({ code, display })),
  }));
}

export function seedTerminology(store: Store): void {
  const fhir = getFhirStore(store);
  for (const codeSystem of terminologyFixtures()) fhir.update("CodeSystem", codeSystem.id!, codeSystem);
}

interface Concept {
  code: string;
  display?: string;
  concept?: Concept[];
}

function findConcept(concepts: Concept[] | undefined, code: string): Concept | undefined {
  for (const concept of concepts ?? []) {
    if (concept.code === code) return concept;
    const nested = findConcept(concept.concept, code);
    if (nested) return nested;
  }
  return undefined;
}

function codeSystemFor(fhir: FhirStore, system: string): FhirResource | undefined {
  return fhir.listCurrent("CodeSystem").find((cs) => cs.url === system);
}

type Parameters = { resourceType: "Parameters"; parameter: Array<Record<string, unknown>> };

/** CodeSystem/$lookup: the display for a code. */
export function lookupCode(fhir: FhirStore, system: string | undefined, code: string | undefined): Parameters {
  if (!system || !code) throw new FhirError(400, "required", "$lookup needs system and code");
  const codeSystem = codeSystemFor(fhir, system);
  if (!codeSystem) throw new FhirError(404, "not-found", `No CodeSystem with url ${system}`);
  const concept = findConcept(codeSystem.concept as Concept[], code);
  if (!concept) throw new FhirError(404, "not-found", `Code ${code} is not in ${system}`);
  return {
    resourceType: "Parameters",
    parameter: [
      { name: "name", valueString: String(codeSystem.name ?? codeSystem.title ?? system) },
      ...(codeSystem.version ? [{ name: "version", valueString: String(codeSystem.version) }] : []),
      ...(concept.display ? [{ name: "display", valueString: concept.display }] : []),
    ],
  };
}

/** CodeSystem/$validate-code: whether a code (and optionally its display) is valid. */
export function validateCode(
  fhir: FhirStore,
  system: string | undefined,
  code: string | undefined,
  display?: string,
): Parameters {
  if (!system || !code) throw new FhirError(400, "required", "$validate-code needs url (or system) and code");
  const codeSystem = codeSystemFor(fhir, system);
  if (!codeSystem) throw new FhirError(404, "not-found", `No CodeSystem with url ${system}`);
  const concept = findConcept(codeSystem.concept as Concept[], code);
  const result = (ok: boolean, message?: string) => ({
    resourceType: "Parameters" as const,
    parameter: [
      { name: "result", valueBoolean: ok },
      ...(concept?.display ? [{ name: "display", valueString: concept.display }] : []),
      ...(message ? [{ name: "message", valueString: message }] : []),
    ],
  });
  if (!concept) {
    const note =
      codeSystem.content === "fragment" ? " (this CodeSystem is a fragment, so the code may exist upstream)" : "";
    return result(false, `Code ${code} is not in ${system}${note}`);
  }
  if (display !== undefined && concept.display !== undefined && display !== concept.display)
    return result(false, `Display "${display}" does not match "${concept.display}" for code ${code}`);
  return result(true);
}
