import type { ServiceEntry } from "./registry.js";

// Health and life science services. Each emulator lives in packages/@emuhealth/<name>.
// Append new names to the end only: a service's position in this list sets its default port.
const HEALTH_SERVICE_NAME_LIST = [
  "fhir",
  "epic",
  "openfda",
  "rxnav",
  "clinicaltrials",
  "ncbi",
  "nppes",
  "benchling",
  "redcap",
  "cerner",
  "athena",
  "bluebutton",
  "cdshooks",
  "redox",
  "healthlake",
  "gcphealthcare",
  "azurehealth",
  "stedi",
  "availity",
] as const;
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
  benchling: {
    label: "Benchling API v2 emulator",
    endpoints:
      "Benchling API v2 under /api/v2 with API key (Basic) or client credentials (Bearer) auth: dna-sequences and aa-sequences (list, filter, page, create, update, archive), entries, registries and register-entities with tasks, assay-results and schemas, projects, folders, events, Svix-signed webhooks; synthetic tenant; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/benchling");
      return { plugin: mod.benchlingPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "benchling-user", id: 1, scopes: [] };
    },
    initConfig: {
      benchling: {
        generate: {
          seed: 1,
          dnaSequences: 10,
        },
        webhooks: [],
      },
    },
  },
  redcap: {
    label: "REDCap API emulator",
    endpoints:
      "REDCap API at POST /api/ with token and content: version, project, metadata, instrument, exportFieldNames, record export (records, fields, forms, filterLogic, rawOrLabel, flat or eav), record import (json or csv, overwriteBehavior, forceAutoNumber, returnContent), record delete, generateNextRecordName; json, csv, or xml; synthetic classic project; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/redcap");
      return { plugin: mod.redcapPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "redcap-user", id: 1, scopes: [] };
    },
    initConfig: {
      redcap: {
        generate: {
          records: 20,
          seed: 1,
        },
      },
    },
  },
  cerner: {
    label: "Oracle Health (Cerner) Millennium FHIR R4 emulator",
    endpoints:
      "Millennium tenant URL shape (/r4/{tenant}) over the full FHIR server, persona OAuth endpoints under /tenants/{tenant}/protocols/oauth2/profiles/smart-v1, system accounts with client_credentials and a client secret, tenant and username in token responses, Millennium's required search parameters, generated synthetic patients, inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/cerner");
      return { plugin: mod.cernerPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "cerner-user", id: 1, scopes: [] };
    },
    initConfig: {
      cerner: {
        generate: {
          patients: 5,
          seed: 1,
        },
        smart: {
          clients: [
            {
              client_id: "my-millennium-app",
              redirect_uris: ["http://localhost:3000/callback"],
            },
          ],
        },
      },
    },
  },
  athena: {
    label: "athenahealth API emulator",
    endpoints:
      "OAuth client credentials at /oauth2/v1/token; proprietary REST under /v1/{practiceid}: departments, providers, patients (search, read, create), chart problems, allergies, medications, vitals, appointments open, booked, book, cancel, with offset and limit paging; FHIR R4 under /fhir/r4 with ah-practice; synthetic records; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/athena");
      return { plugin: mod.athenaPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "athena-user", id: 1, scopes: [] };
    },
    initConfig: {
      athena: {
        practiceIds: ["195900"],
        generate: {
          patients: 5,
          seed: 1,
        },
        scheduling: {
          days: 10,
        },
      },
    },
  },
  bluebutton: {
    label: "CMS Blue Button 2.0 emulator",
    endpoints:
      "Patient access OAuth at /v2/o/authorize/ and /v2/o/token/ with a beneficiary picker, /v2/connect/userinfo, FHIR R4 at /v2/fhir with Patient (synthetic MBIs), Coverage (Parts A, B, D), and ExplanationOfBenefit (carrier and Part D claims), read-only and token-only; synthetic beneficiaries",
    async load() {
      const mod = await import("@emuhealth/bluebutton");
      return { plugin: mod.bluebuttonPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "bluebutton-user", id: 1, scopes: [] };
    },
    initConfig: {
      bluebutton: {
        generate: {
          patients: 5,
          seed: 1,
        },
        smart: {
          clients: [
            {
              client_id: "my-blue-button-app",
              redirect_uris: ["http://localhost:3000/callback"],
            },
          ],
        },
      },
    },
  },
  cdshooks: {
    label: "CDS Hooks emulator (simulated EHR and sample services)",
    endpoints:
      "Simulated EHR: POST /ehr/fire reads your CDS service discovery and fires patient-view, order-sign, order-select, or encounter-start with a signed JWT (JWKS at /.well-known/jwks.json), context, prefetch, and fhirAuthorization from its FHIR server at /fhir, then validates the cards; GET /ehr/invocations; sample CDS services at /cds-services (patient-greeting, allergy-check) with feedback; inspector form at /_inspector",
    async load() {
      const mod = await import("@emuhealth/cdshooks");
      return { plugin: mod.cdshooksPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "cdshooks-user", id: 1, scopes: [] };
    },
    initConfig: {
      cdshooks: {
        services: ["http://localhost:3000/cds-services"],
      },
    },
  },
  redox: {
    label: "Redox API emulator",
    endpoints:
      "Authentication (/auth/authenticate, /auth/refreshToken, /v2/auth/token), POST /endpoint for Redox JSON data models (PatientSearch Query, ClinicalSummary PatientQuery, PatientAdmin NewPatient and PatientUpdate, Scheduling New, Reschedule, Cancel, Results, Notes, Media) with Meta.Errors, destination webhooks with the verification-token header, the challenge handshake, and POST /ehr/send to simulate EHR events; synthetic records; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/redox");
      return { plugin: mod.redoxPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "redox-user", id: 1, scopes: [] };
    },
    initConfig: {
      redox: {
        destinations: [
          {
            url: "http://localhost:3000/redox",
            verificationToken: "synthetic-verification-token",
          },
        ],
      },
    },
  },
  healthlake: {
    label: "AWS HealthLake emulator",
    endpoints:
      "HealthLake JSON control plane at POST / (X-Amz-Target HealthLake.*: Create, Describe, List, Delete FHIR datastores; Start, Describe, List import and export jobs) and a FHIR R4 data plane per datastore at /datastore/{id}/r4, with SigV4 verification for service healthlake; a default datastore preloaded with synthetic data; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/healthlake");
      return { plugin: mod.healthlakePlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "healthlake-user", id: 1, scopes: [] };
    },
    initConfig: {
      healthlake: {
        region: "us-east-1",
        datastores: [
          {
            id: "5e7e0000000000000000000000000001",
            name: "synthetic",
            preload: true,
          },
        ],
      },
    },
  },
  gcphealthcare: {
    label: "Google Cloud Healthcare API emulator (FHIR stores)",
    endpoints:
      "Cloud Healthcare API v1 under /v1/projects/{project}/locations/{location}: datasets (create as operations, get, list, delete, operations), FHIR stores (create, get, list, patch with updateMask, delete, :export and :import operations), and a FHIR R4 API per store at .../fhirStores/{store}/fhir honoring enableUpdateCreate; any Bearer token; Google JSON errors; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/gcphealthcare");
      return { plugin: mod.gcphealthcarePlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "gcphealthcare-user", id: 1, scopes: [] };
    },
    initConfig: {
      gcphealthcare: {
        datasets: [
          {
            project: "synthetic-project",
            location: "us-central1",
            id: "synthetic-dataset",
            fhirStores: [
              {
                id: "synthetic-fhir-store",
                enableUpdateCreate: true,
                preload: true,
              },
            ],
          },
        ],
      },
    },
  },
  azurehealth: {
    label: "Azure Health Data Services emulator (FHIR services)",
    endpoints:
      "FHIR services per workspace at /{workspace}-{fhirservice} (the path form of {workspace}-{fhirservice}.fhir.azurehealthcareapis.com), each a full FHIR R4 server; Entra ID Bearer tokens required (public metadata), verified against an issuer's JWKS such as the emuhealth Microsoft emulator when azurehealth.entra is set; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/azurehealth");
      return { plugin: mod.azurehealthPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "azurehealth-user", id: 1, scopes: [] };
    },
    initConfig: {
      azurehealth: {
        workspaces: [
          {
            name: "synthetic",
            fhirServices: [
              {
                name: "fhir",
                preload: true,
              },
            ],
          },
        ],
      },
    },
  },
  stedi: {
    label: "Stedi healthcare clearinghouse emulator",
    endpoints:
      "Stedi 2024-04-01 healthcare APIs with an API key: eligibility v3 (270/271), professional claims v3 submission (837P) with immediate adjudication, claim status v2 (276/277), 835 ERA reports by transaction, transactions list, payers; transaction.processed.v2 events to webhooks; synthetic payers and members; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/stedi");
      return { plugin: mod.stediPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "stedi-user", id: 1, scopes: [] };
    },
    initConfig: {
      stedi: {
        generate: {
          patients: 5,
          seed: 1,
        },
      },
    },
  },
  availity: {
    label: "Availity API emulator",
    endpoints:
      "Availity HIPAA transaction APIs under /availity: OAuth client credentials (/v1/token), availity-payer-list, v1/configurations, asynchronous v1/coverages (270/271) and v1/claim-statuses (276/277) polled until statusCode 4, v2/service-reviews (278) with Location polling, and Demo plan X-Api-Mock-Scenario-ID scenarios; synthetic payers, members, and claims; inspector at /_inspector",
    async load() {
      const mod = await import("@emuhealth/availity");
      return { plugin: mod.availityPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "availity-user", id: 1, scopes: [] };
    },
    initConfig: {
      availity: {
        generate: {
          patients: 5,
          seed: 1,
        },
        pollsUntilComplete: 1,
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
