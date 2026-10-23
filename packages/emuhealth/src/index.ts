import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { SERVICE_NAMES } from "./registry.js";
import { projectStartCommand } from "./commands/project-start.js";
import { scaffoldCommand } from "./commands/scaffold.js";
import { SYNTHETIC_DATA_NOTICE } from "./data-policy.js";
import { brandedEnv } from "./env.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

const defaultPort = brandedEnv("PORT") ?? process.env.PORT ?? "4000";

const program = new Command();

program
  .name("emuhealth")
  .description("Local drop-in replacement services for CI and no-network sandboxes")
  .version(pkg.version)
  .addHelpText(
    "after",
    `
Data policy:
  ${SYNTHETIC_DATA_NOTICE}

FHIR R4:
  'npx emuhealth --service fhir' serves a FHIR R4 server at http://localhost:4100 (base port + 100).
  Supports create, read, vread, update (create on update), JSON Patch, logical delete, and _history.
  Writes return ETag W/"<versionId>"; If-Match conflicts return 412. Errors are OperationOutcome resources.
  Search with GET /:type or POST /:type/_search: string, token, date, and reference parameters, _sort, _count,
  _include, _revinclude, and chained parameters such as patient.family.
  POST / with a batch or transaction Bundle; transactions roll back on failure and resolve urn:uuid references.
  GET /metadata returns the CapabilityStatement. GET /Patient/:id/$everything returns a patient's full record.
  Browse resources, versions, SMART clients and tokens, and exports at http://localhost:4100/_inspector.
  Bulk Data: GET /$export, /Patient/$export, /Group/:id/$export with Prefer: respond-async for NDJSON files.
  Starts with 5 generated synthetic patients; fhir.generate sets patients, seed, and referenceDate, or false for none.
  Terminology fixtures: GET /CodeSystem/$lookup and /CodeSystem/$validate-code; fhir.terminology: false leaves them out.
  Load extra synthetic resources under fhir.resources.
  SMART App Launch: /.well-known/smart-configuration, /auth/authorize (patient and practitioner pickers),
  /auth/token (PKCE S256), /auth/launch (EHR launch simulator). Register clients under fhir.smart.clients.
  Presented tokens are enforced (scopes, patient compartment); fhir.smart.required: true requires a token everywhere.
  Backend Services: client_credentials with a private_key_jwt assertion for clients registered with jwks or jwks_uri.
  Docs: https://www.emuhealth.dev/docs/fhir

Epic:
  'npx emuhealth --service epic' serves the FHIR R4 server the way Epic does, at http://localhost:4101/api/FHIR/R4.
  OAuth 2.0 at /oauth2/authorize and /oauth2/token; token responses with a patient add __epic.dstu2.patient.
  Empty searches return Epic's informational OperationOutcome (code 4101) in the Bundle.
  POST /api/FHIR/R4/Appointment/$find and /Appointment/$book schedule into generated Slots (epic.scheduling).
  Configure it under epic with the same keys as fhir (generate, resources, smart, terminology).
  Docs: https://www.emuhealth.dev/docs/epic

openFDA:
  'npx emuhealth --service openfda' serves openFDA endpoints at http://localhost:4102 with synthetic data.
  GET /drug/label.json, /drug/event.json, /drug/enforcement.json, /device/enforcement.json, /food/enforcement.json.
  search=field:term with "phrases", .exact, [a TO b] ranges, AND, OR, NOT, _exists_; sort=field:desc; count=field.
  limit defaults to 1 (max 1000); skip pages. No matches return 404 {"error":{"code":"NOT_FOUND"}}.
  openfda.generate sets seed and events, or false for none; openfda.records adds records per endpoint.
  Docs: https://www.emuhealth.dev/docs/openfda

RxNav:
  'npx emuhealth --service rxnav' serves the RxNorm REST API at http://localhost:4103/REST.
  GET /REST/rxcui.json?name=, /REST/drugs.json?name=, /REST/rxcui/:rxcui/properties.json, /related.json?tty=,
  /allrelated.json, /ndcs.json, /REST/approximateTerm.json?term=, /REST/spellingsuggestions.json?name=.
  Starts with RxNorm ingredients and clinical drugs; rxnav.concepts adds concepts, rxnav.defaults: false drops the subset.
  Docs: https://www.emuhealth.dev/docs/rxnav

ClinicalTrials.gov:
  'npx emuhealth --service clinicaltrials' serves ClinicalTrials.gov API v2 at http://localhost:4104/api/v2.
  GET /api/v2/studies with query.cond, query.term, query.intr, query.locn, filter.overallStatus, filter.ids,
  filter.advanced (AREA[Piece]value), sort, fields, pageSize (max 1000), pageToken, countTotal; GET /api/v2/studies/:nctId.
  Synthetic studies use NCT99 ids; clinicaltrials.generate sets studies and seed, clinicaltrials.studies adds your own.
  Docs: https://www.emuhealth.dev/docs/clinicaltrials

NCBI E-utilities:
  'npx emuhealth --service ncbi' serves E-utilities at http://localhost:4105/entrez/eutils for db=pubmed and db=gene.
  einfo.fcgi, esearch.fcgi (term with [ti] [au] [mh] [dp] tags, AND, OR, NOT; retstart, retmax, usehistory=y),
  esummary.fcgi, efetch.fcgi (PubMed XML or rettype=abstract text), elink.fcgi (dbfrom=gene&db=pubmed). retmode=json for JSON.
  PubMed articles are synthetic (PMIDs from 99000001); ncbi.generate sets articles and seed, or false for none.
  Docs: https://www.emuhealth.dev/docs/ncbi

NPPES NPI Registry:
  'npx emuhealth --service nppes' serves the NPI Registry API at http://localhost:4106/api/?version=2.1.
  Search by number, enumeration_type (NPI-1, NPI-2), first_name, last_name, organization_name (trailing *),
  taxonomy_description, city, state, postal_code; limit (max 200), skip (max 1000). Missing criteria return Errors.
  Synthetic providers: NPIs start with 0; nppes.generate sets individuals, organizations, seed; nppes.providers adds your own.
  Docs: https://www.emuhealth.dev/docs/nppes

Benchling:
  'npx emuhealth --service benchling' serves Benchling API v2 at http://localhost:4107/api/v2 (any API key as Basic auth).
  dna-sequences and aa-sequences (GET list with filters and nextToken, POST, PATCH, :archive, :unarchive),
  entries, registries/:id:register-entities and tasks/:id, assay-results, entity-schemas, projects, folders, events.
  benchling.webhooks sends Svix-signed events (v2.entry.created, v2.entity.registered) to your URLs.
  Docs: https://www.emuhealth.dev/docs/benchling

REDCap:
  'npx emuhealth --service redcap' serves the REDCap API at http://localhost:4108/api/ (POST, form encoded).
  token=5E7E0000000000000000000000000001 unless redcap.tokens is set; content=version, project, metadata,
  instrument, exportFieldNames, record (action=export, import, delete), generateNextRecordName; format=json, csv, xml.
  Exports take records[], fields[], forms[], filterLogic, rawOrLabel, type=eav. Imports validate against the dictionary.
  Docs: https://www.emuhealth.dev/docs/redcap

Oracle Health (Cerner):
  'npx emuhealth --service cerner' serves FHIR R4 the way Oracle Health Millennium does, at
  http://localhost:4109/r4/5e7e0000-0000-4000-8000-000000000001 (a synthetic tenant).
  OAuth under /tenants/{tenant}/protocols/oauth2/profiles/smart-v1 (personas/provider/authorize, personas/patient/authorize, token).
  System accounts: client_credentials with a client secret. Searches need Millennium's required parameters (patient, _id, ...).
  Configure it under cerner with the same keys as fhir (generate, resources, smart, terminology).
  Docs: https://www.emuhealth.dev/docs/cerner

athenahealth:
  'npx emuhealth --service athena' serves athenahealth APIs at http://localhost:4110 for practice 195900.
  POST /oauth2/v1/token (client_credentials, Basic auth) gives a Bearer token for both APIs.
  /v1/{practiceid}: departments, providers, patients (GET search and read, POST create), chart/{patientid}/problems,
  allergies, medications, vitals (departmentid required), appointments/open, appointments/booked, PUT appointments/{id}, /cancel.
  FHIR R4 at /fhir/r4; searches need ah-practice=Organization/a-1.Practice-195900.
  Docs: https://www.emuhealth.dev/docs/athena

CMS Blue Button 2.0:
  'npx emuhealth --service bluebutton' serves CMS Blue Button 2.0 at http://localhost:4111.
  OAuth: /v2/o/authorize/ (beneficiary picker), /v2/o/token/ (PKCE), /v2/connect/userinfo.
  FHIR R4 at /v2/fhir, token required, read-only: Patient, Coverage (beneficiary=), ExplanationOfBenefit
  (patient=, type=CARRIER or PDE, service-date=). Beneficiaries are synthetic with MBIs that contain S.
  Docs: https://www.emuhealth.dev/docs/bluebutton

CDS Hooks:
  'npx emuhealth --service cdshooks' runs a simulated EHR at http://localhost:4112.
  POST /ehr/fire {discoveryUrl, hook, patientId, medication?} fires a hook at your CDS service with a signed JWT
  (JWKS at /.well-known/jwks.json), prefetch and fhirAuthorization from the FHIR server at /fhir, and validates cards.
  Sample CDS services at /cds-services (patient-greeting, allergy-check). Fire hooks from the form at /_inspector.
  Docs: https://www.emuhealth.dev/docs/cdshooks

Redox:
  'npx emuhealth --service redox' serves the Redox API at http://localhost:4113.
  POST /auth/authenticate {apiKey, secret} (any pair unless redox.sources is set) or /v2/auth/token for a Bearer token.
  POST /endpoint with Redox data models: PatientSearch Query, ClinicalSummary PatientQuery, PatientAdmin, Scheduling, Results.
  POST /ehr/send {DataModel, EventType, patientId} delivers an EHR event to redox.destinations with verification-token.
  Docs: https://www.emuhealth.dev/docs/redox

AWS HealthLake:
  'npx emuhealth --service healthlake' serves AWS HealthLake at http://localhost:4114 (use it as the endpoint URL).
  Requests need SigV4 for service healthlake; the default key pair is AWS's documented example (AKIAIOSFODNN7EXAMPLE).
  Control plane: CreateFHIRDatastore, DescribeFHIRDatastore, ListFHIRDatastores, DeleteFHIRDatastore, import and export jobs.
  Data plane: FHIR R4 at /datastore/{id}/r4; datastore 5e7e0000000000000000000000000001 is preloaded with synthetic patients.
  Docs: https://www.emuhealth.dev/docs/healthlake

Google Cloud Healthcare API:
  'npx emuhealth --service gcphealthcare' serves the Cloud Healthcare API at http://localhost:4115/v1 (any Bearer token).
  Datasets: POST .../datasets?datasetId= (operation), GET, list, DELETE. FHIR stores: POST .../fhirStores?fhirStoreId=,
  GET, list, PATCH ?updateMask=, DELETE, :export, :import. FHIR R4 at .../fhirStores/{store}/fhir.
  Default store: projects/synthetic-project/locations/us-central1/datasets/synthetic-dataset/fhirStores/synthetic-fhir-store.
  Docs: https://www.emuhealth.dev/docs/gcphealthcare

Azure Health Data Services:
  'npx emuhealth --service azurehealth' serves Azure Health Data Services FHIR at http://localhost:4116/{workspace}-{fhirservice}.
  Default service: http://localhost:4116/synthetic-fhir (preloaded). Requests need an Entra ID Bearer token; /metadata is public.
  Set azurehealth.entra.issuer (for example the microsoft service: http://localhost:4005/<tenant>/v2.0) to verify tokens:
  get one from the microsoft service with client_credentials and scope http://localhost:4116/synthetic-fhir/.default.
  Docs: https://www.emuhealth.dev/docs/azurehealth

Stedi:
  'npx emuhealth --service stedi' serves Stedi healthcare APIs at http://localhost:4117 (any API key in Authorization).
  POST /2024-04-01/change/medicalnetwork/eligibility/v3, /professionalclaims/v3/submission, /claimstatus/v2;
  GET /2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835, /2023-08-01/transactions, /2024-04-01/payers.
  Payers SYN01 and SYN02; members SYNM000001 and up from the synthetic patients. Claims are paid at once with an 835.
  Docs: https://www.emuhealth.dev/docs/stedi

Framework adapters:
  Embed emulators in app routes with @emulators/adapter-next or @emulators/adapter-nuxt.
  Docs: https://www.emuhealth.dev/docs/nextjs and https://www.emuhealth.dev/docs/nuxt

Networking:
  Built-in and custom listeners bind to 127.0.0.1 by default.
  Use --host 0.0.0.0 for access from containers or other machines.
  createEmulator accepts hostname for the listening address.
  Use --base-url or baseUrl for advertised URLs reachable by those clients.

Custom emulators:
  Build and share emulators for third-party HTTP APIs alongside the built-in services.
  Run 'npx emuhealth init --custom inventory' to scaffold an emulator, config, and runnable test.
  Adapt the generated inventory routes, state, and test to the provider your app uses.
  Existing YAML, JSON, TypeScript, and JavaScript configs get a service entry when supported.
  For unusual executable configs, init prints the import and service entry to add manually.
  Init prints the test command; use the service URL and Inspector link printed by start for requests.
  Run 'npx emuhealth start --watch' to reload local modules and inspect requests at /_emulate.
  Creating a missing local import retries a failed reload, including outside the config directory.
  Import defineEmulator, defineConfig, and createEmulator from 'emuhealth'.
  Test in process with createEmulator({ service: yourDefinition, listen: false }).
  Custom emulators support seeds, reset, snapshots, restore, and opt-in persistence.
  Streamed responses persist state changes during delivery; reset and close cancel active streams before cleanup.
  Appended Set-Cookie headers retain cookies already on a response.
  Config accepts local TypeScript/JavaScript files and installed packages alongside built-ins.
  Node loads TypeScript with tsconfig aliases and source maps; no extra runtime packages are needed.
  Node 26 requires erasable TypeScript; compile enums and parameter properties to JavaScript first.
  Node 24 also supports native TypeScript transforms.
  Successful watch reloads reset the run to seed; auto-detected config files created later also trigger reloads.
  Reload errors keep the previous runner when possible.
  Structured inspection redacts token and secret fields, including access_token and client_secret.
  Framework adapters keep root-relative custom redirects under the service mount.
  Export OPTIONS from the Next.js handler to forward preflight and custom OPTIONS routes.
  Docs: https://www.emuhealth.dev/docs/custom-emulators

GitHub API coverage:
  Includes repository contents, raw downloads, raw media negotiation for file Contents and README responses,
  commit history, commit details, ref comparisons, organization membership seeding with member/admin roles,
  and Checks list-by-ref endpoints for branch and tag refs containing slashes.
  Check-run lists paginate with page/per_page (default 30, maximum 100) and Link headers.
  Ref lists filter before pagination; total_count includes all filtered runs.
  Checks retain the authenticated installation's App in API responses and webhooks.
  Suites are separated by App and commit; latest runs are grouped by App and check name.
  User-token checks return app: null; request-body app_id cannot change attribution.
  Inspect minted installation-token metadata at GET /_emulate/installation-tokens.

Linear API coverage:
  Issue queries and mutations include numeric priority and derived priorityLabel fields.

Vercel API coverage:
  GET /v7/deployments lists deployments by commit SHA across a team's projects, with cursor pagination.

AWS API coverage:
  S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags.
  SQS supports current AWS SDK clients using AWS JSON 1.0 at /sqs, alongside XML Query requests.
  Queue operations also accept the returned QueueUrl as the endpoint.
  Cognito User Pools use /cognito-idp and Identity Pools use /cognito-identity with the AWS SDK v3.
  Seed aws.cognito.user_pools and identity_pools; defaults are us-east-1_emulate and app client emulateclient.
  Sign-up, confirmation, password/reset/refresh flows, new-password challenges, and admin user operations are supported.
  Local confirmation codes default to 123456 and appear at /_inspector?tab=cognito; no email/SMS is sent.
  RS256 tokens, discovery, and JWKS use the issuer BASE_URL/cognito-idp/USER_POOL_ID.
  That issuer serves /oauth2/authorize (local user picker), /oauth2/token (code/refresh + S256 PKCE), and /oauth2/userInfo.
  Identity Pools support GetId and GetCredentialsForIdentity with validated User Pool ID tokens.
  SRP, MFA, external federation, pool/client management APIs, and IAM policy/signature evaluation are not simulated.

Google Calendar discovery:
  GET /discovery/v1/apis/calendar/v3/rest returns the public discovery document for the emulated Calendar v3 surface.

Google OIDC:
  Discovery advertises RS256 ID tokens, and GET /oauth2/v3/certs returns the RSA public key used to verify them.
  Set google.strict_scopes: true in seed config to validate issued access tokens, expiry, revocation, and method scopes.
  Strict mode returns Google-style 401/403 errors and limits userinfo claims; bearer-token defaults remain permissive.

Resend API coverage:
  POST /emails and POST /emails/batch support 24-hour Idempotency-Key replay without duplicate emails or webhooks.
  Optional resend.allowlist restricts to/cc/bcc recipients; [] rejects all, and omission accepts all.
  Rejected batches create no emails or webhooks. Validated sends record resend.send_attempts in saved state.
  Idempotency replays and malformed requests do not add attempts; rejected sends can be retried with the same key.

Microsoft OAuth coverage:
  Refresh tokens are bound to the issuing client and require its client_id and client_secret, or client_secret_basic.
  Legacy refresh records without a stored client binding remain supported.

Webhook signatures:
  Stripe webhook secrets produce a Stripe-Signature header for raw-body verification.
  Slack signing_secret produces X-Slack-Request-Timestamp and X-Slack-Signature for outbound event callbacks.
  The Slack signature covers v0:<timestamp>:<raw-body>; configure the receiver with the same secret.
  Slack callbacks are unsigned when signing_secret is absent or empty.

Available services:
  ${SERVICE_NAMES.join(", ")}
  Run 'npx emuhealth list' for endpoint summaries.

Configuration:
  Run 'npx emuhealth init' to create a starter emuhealth.config.yaml, or pass --seed <file>.
  GitHub App private keys may be omitted for createEmulator; CLI startup generates omitted keys only with
  --generated-secrets-file <path>.

Twilio API coverage:
  Accounts, API keys, phone numbers, Messaging, Verify, Voice, Conversations, webhooks, simulators, and inspector.

Slack interactivity:
  Configure slack.oauth_apps[].interactivity_url and slack.signing_secret for signed button and modal callbacks.
  POST /_slack/simulate/block-actions clicks a stored button; POST /_slack/simulate/view-submission submits a modal.
  Button response URLs support private/public replies and source updates for five uses within 30 minutes.
  Modal acknowledgements can close, clear, update, push, or show errors. Triggers expire in 3 seconds by default;
  slack.view_trigger_ttl_seconds can extend their lifetime for local tests.

Slack app lifecycle:
  POST /api/apps.uninstall accepts client_id, client_secret, and a user token or configured development token.
  It revokes the app's OAuth credentials in that workspace and emits app_uninstalled and tokens_revoked.
  Revoked tokens return token_revoked even with permissive authentication. Granular bot tokens return no_permission.
  A new OAuth installation issues fresh credentials; other apps and workspaces are unaffected.

Slack message limits:
  Slack text fields are limited to 40,000 Unicode characters. Longer text is truncated safely,
  and successful Web API responses include message_truncated warning metadata.

Slack channel privacy:
  POST /api/admin.conversations.convertToPrivate and convertToPublic accept channel_id.
  Use a user token for a seeded admin; bot/test tokens and non-admin users are rejected.
  Strict scopes require admin.conversations:write. Conversions update visibility and emit conversion messages.
  DMs, MPIMs, and repeated conversions are rejected; #general cannot become private.
  Enterprise plan, organization installation, and channel-management policies are not simulated.

Slack Connect fixtures:
  Seed slack.users[].team_id to model an external author; is_stranger is an optional fixture flag.
  Channels with external members report is_ext_shared and is_shared; events include is_ext_shared_channel.
  App mentions carry the external author's user_team/source_team while the envelope keeps the receiving team.
  Seed slack.channels[].is_ext_shared for existing shares. Invitation/approval and workspace unlink flows are not simulated.

Slack event callbacks:
  POST /_slack/simulate/event-retry accepts event_id and optional reason (default http_timeout).
  It resends the latest recorded delivery with increasing retry headers and a fresh Slack signature when configured.
  Retries are explicit, target one original subscription, and require retained in-memory delivery history.
  Event callbacks include token, api_app_id, authorizations, team_id, event_id, and event_time.
  The team comes from the presented token's installation, or affected resource or seeded team
  for development tokens. Incoming webhooks use their webhook or target channel team.
  Each logical event has a distinct ID shared across subscriber deliveries.
  chat.postMessage emits app_mention for installed bots mentioned as <@BOT_USER_ID> in joined channels.
  Subscribe to app_mention and invite the bot with conversations.invite. DMs and MPIMs use message events.
  Mention callbacks include api_app_id and retain message and thread identity.
  Each workspace installation receives its own envelope; shared subscriptions can route by api_app_id.
  Without an installation, api_app_id is A000000001. verification_token defaults to emulate-verification-token.
  Inner events include event_ts; message events identify channel, group, im, or mpim in channel_type.
  Issued or seeded bot tokens add stored bot identity to messages, history, and replies.
  Removing an installed bot emits channel_left or group_left with actor_id and event_ts.
`,
  );

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port (health services start at base + 100)", defaultPort)
  .option("--host <host>", "Listening address (use 0.0.0.0 for network access)", "127.0.0.1")
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
  .option("--config <file>", "Path to TypeScript, JavaScript, YAML, or JSON configuration")
  .option("--watch", "Watch imports and fixtures; successful reloads reset state to seed")
  .option("--base-url <url>", "Override advertised base URL (supports {service} template)")
  .option("--portless", "Serve over HTTPS via portless (auto-registers aliases)")
  .option(
    "--generated-secrets-file <path>",
    "Write service-generated secrets to a new owner-only JSON file (Linux requires setfacl and getfacl)",
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    const options = {
      port,
      host: opts.host,
      service: opts.service,
      seed: opts.seed,
      config: opts.config,
      watch: opts.watch,
      baseUrl: opts.baseUrl,
      portless: opts.portless,
      generatedSecretsFile: opts.generatedSecretsFile,
    };
    try {
      await projectStartCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .option("--custom <name>", "Scaffold a third-party API emulator, config, and test")
  .option("--config <file>", "Existing configuration to update when scaffolding a custom API")
  .action((opts) => {
    try {
      if (opts.custom) scaffoldCommand(opts.custom, opts.config);
      else initCommand({ service: opts.service });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .option("--config <file>", "Configuration containing custom services")
  .action(async (opts) => {
    try {
      await listCommand(opts.config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program.parse();
