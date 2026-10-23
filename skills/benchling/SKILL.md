---
name: benchling
description: Emulated Benchling API v2 for local development and testing of Benchling apps and integrations. Use when the user is building against Benchling DNA or AA sequences, notebook entries, the registry, assay results, events, or Benchling webhooks. Triggers include "Benchling", "Benchling API", "Benchling app", "register entities", "assay results", "Benchling webhook", or any task needing a local Benchling tenant.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Benchling API v2 Emulator

A synthetic Benchling tenant under `/api/v2`. Not affiliated with Benchling.

## Start

```bash
npx emuhealth --service benchling
curl -u sk_any_key: http://localhost:4107/api/v2/dna-sequences
```

Auth: any API key as the Basic username, or `POST /api/v2/token` (`grant_type=client_credentials`) for a Bearer token. Missing auth: `401 {"error":{"type":"invalid_request_error",...}}`.

## Endpoints

- `dna-sequences`, `aa-sequences`: list (`name`, `nameIncludes`, `folderId`, `schemaId`, `registryId`, `entityRegistryIds.anyOf`, `archiveReason`, `pageSize`, `nextToken`), `POST`, `GET /{id}`, `PATCH /{id}`, `POST /dna-sequences:archive` and `:unarchive`.
- `entries`: list, `POST` (`name`, `folderId`), `GET /{id}` (returns `{ entry }`), `PATCH /{id}`.
- `POST /registries/{id}:register-entities` (`entityIds`, `namingStrategy`) returns `202 { taskId }`; `GET /tasks/{id}` is `SUCCEEDED` with the registered entities.
- `assay-results`: `GET ?schemaId=` (required), `POST { assayResults: [{ schemaId, projectId, fields }] }`, `GET /{id}`.
- `entity-schemas`, `assay-result-schemas`, `registries`, `projects`, `folders`, `events`.

Synthetic ids: project `src_SYNPROJ1`, folders `lib_SYNSEQS1` and `lib_SYNNOTE1`, schemas `ts_SYNPLSM1` (Plasmid, prefix PLS) and `ts_SYNPROT1` (Protein), registry `src_SYNREG01`, assay schema `assaysch_SYNABS1` (sample, wavelength_nm, absorbance).

## Webhooks

```yaml
benchling:
  webhooks:
    - url: http://localhost:3000/benchling/webhook
      events: [v2.entry.created, v2.entity.registered]
      secret: whsec_c3ludGhldGljLXNlY3JldA==
```

Signed like Svix: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256("id.timestamp.body")>`.

Docs: https://www.emuhealth.dev/docs/benchling
