import type { ServiceEntry } from "./registry.js";

// Health and life science services. Each emulator lives in packages/@emuhealth/<name>.
// Append new names to the end only: a service's position in this list sets its default port.
const HEALTH_SERVICE_NAME_LIST = ["fhir", "epic", "openfda", "rxnav", "clinicaltrials", "ncbi", "nppes"] as const;
export type HealthServiceName = (typeof HEALTH_SERVICE_NAME_LIST)[number];
export const HEALTH_SERVICE_NAMES: readonly HealthServiceName[] = HEALTH_SERVICE_NAME_LIST;

export const HEALTH_SERVICE_REGISTRY: Record<HealthServiceName, ServiceEntry> = {
  fhir: {
    label: "FHIR R4 server emulator",
    endpoints:
      "create, read, vread, update (including create on update), JSON Patch, logical delete, _history, search with includes and chaining, batch and transaction Bundles, CapabilityStatement at /metadata, Patient/$everything, Bulk Data $export, SMART App Launch and Backend Services, ETag and If-Match, generated synthetic patients, terminology $lookup and $validate-code, inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/fhir-core");
      return { plugin: mod.fhirPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "fhir-user", id: 1, scopes: [] };
    },
    initConfig: {
      fhir: {
        generate: { patients: 5, seed: 1 },
        resources: [
          {
            resourceType: "Patient",
            id: "synthetic-patient-1",
            name: [{ family: "Example", given: ["Jamie"] }],
            gender: "female",
            birthDate: "1980-01-01",
          },
        ],
      },
    },
  },
  epic: {
    label: "Epic FHIR R4 emulator",
    endpoints:
      "Epic URL shape (/api/FHIR/R4) over the full FHIR server, OAuth 2.0 at /oauth2/authorize and /oauth2/token with SMART App Launch and Backend Services, __epic.dstu2.patient in token responses, informational OperationOutcome (4101) on empty searches, Schedules and Slots with Appointment/$find and Appointment/$book, generated synthetic patients, inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/epic");
      return { plugin: mod.epicPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "epic-user", id: 1, scopes: [] };
    },
    initConfig: {
      epic: {
        generate: { patients: 5, seed: 1 },
        scheduling: { days: 10 },
        smart: { clients: [{ client_id: "my-epic-app", redirect_uris: ["http://localhost:3000/callback"] }] },
      },
    },
  },
  openfda: {
    label: "openFDA API emulator",
    endpoints:
      "drug labels (/drug/label.json), adverse event reports (/drug/event.json), and recalls (/drug/enforcement.json, /device/enforcement.json, /food/enforcement.json) with the openFDA query language (search, sort, count, limit, skip), synthetic datasets, inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/openfda");
      return { plugin: mod.openfdaPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "openfda-user", id: 1, scopes: [] };
    },
    initConfig: {
      openfda: {
        generate: { seed: 1, events: 300 },
      },
    },
  },
  rxnav: {
    label: "NLM RxNav (RxNorm API) emulator",
    endpoints:
      "RxNorm REST API under /REST: rxcui by name, drugs, properties, related and allrelated concepts, ndcs, approximateTerm, spellingsuggestions, displaynames, with or without .json; built-in RxNorm subset plus configured concepts; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/rxnav");
      return { plugin: mod.rxnavPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "rxnav-user", id: 1, scopes: [] };
    },
    initConfig: {
      rxnav: {
        concepts: [
          {
            rxcui: "900001",
            name: "examplemab",
            tty: "IN",
          },
        ],
      },
    },
  },
  clinicaltrials: {
    label: "ClinicalTrials.gov API v2 emulator",
    endpoints:
      "ClinicalTrials.gov API v2 under /api/v2: studies search (query.cond, query.term, query.intr, query.titles, query.locn, query.spons, query.id, filter.overallStatus, filter.ids, filter.advanced AREA[], sort, fields, pageSize, pageToken, countTotal), single studies, version, stats/size; synthetic studies in the NCT99 range; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/clinicaltrials");
      return { plugin: mod.clinicaltrialsPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "clinicaltrials-user", id: 1, scopes: [] };
    },
    initConfig: {
      clinicaltrials: {
        generate: {
          studies: 60,
          seed: 1,
        },
      },
    },
  },
  ncbi: {
    label: "NCBI E-utilities emulator (PubMed and Gene)",
    endpoints:
      "E-utilities under /entrez/eutils: einfo, esearch (field tags, AND/OR/NOT, [dp] ranges, retstart/retmax, usehistory WebEnv), esummary, efetch (PubMed XML and abstract text), elink (gene and pubmed), GET or POST, JSON or XML; synthetic PubMed articles and real human genes; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/ncbi");
      return { plugin: mod.ncbiPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "ncbi-user", id: 1, scopes: [] };
    },
    initConfig: {
      ncbi: {
        generate: {
          articles: 80,
          seed: 1,
        },
      },
    },
  },
  nppes: {
    label: "NPPES NPI Registry API emulator",
    endpoints:
      "NPI Registry API at /api/?version=2.1: number, enumeration_type, first_name, last_name, organization_name (trailing * wildcards), taxonomy_description, address_purpose, city, state, postal_code, country_code, limit (max 200), skip; the registry's Errors shapes; synthetic providers with NPIs that start with 0; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/nppes");
      return { plugin: mod.nppesPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "nppes-user", id: 1, scopes: [] };
    },
    initConfig: {
      nppes: {
        generate: {
          individuals: 40,
          organizations: 15,
          seed: 1,
        },
      },
    },
  },
};

// Health services listen on basePort + 100 + their position in HEALTH_SERVICE_NAMES
// (4100, 4101, ... with the default base port), so adding upstream services never moves them.
export const HEALTH_PORT_OFFSET = 100;

export function defaultServicePort(
  service: string,
  basePort: number,
  index: number,
  healthNames: readonly string[] = HEALTH_SERVICE_NAMES,
): number {
  const healthIndex = healthNames.indexOf(service);
  return healthIndex === -1 ? basePort + index : basePort + HEALTH_PORT_OFFSET + healthIndex;
}
