---
name: gcphealthcare
description: Emulated Google Cloud Healthcare API (datasets and FHIR stores) for local development and testing. Use when the user creates datasets or FHIR stores on Google Cloud, calls a Cloud Healthcare FHIR store, or tests enableUpdateCreate behavior. Triggers include "Google Cloud Healthcare", "Cloud Healthcare API", "healthcare.googleapis.com", "GCP FHIR store", or any task needing a local Cloud Healthcare FHIR store.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Google Cloud Healthcare API Emulator

Datasets, FHIR stores, and a FHIR R4 API per store. Not affiliated with Google.

## Start

```bash
npx emuhealth --service gcphealthcare
STORE=projects/synthetic-project/locations/us-central1/datasets/synthetic-dataset/fhirStores/synthetic-fhir-store
curl -H 'Authorization: Bearer test' http://localhost:4115/v1/$STORE/fhir/Patient
```

Any Bearer token; none gives `401 {"error":{"status":"UNAUTHENTICATED"}}`.

## Management (`/v1/projects/{p}/locations/{l}`)

- `POST datasets?datasetId=` (completed operation), `GET datasets`, `GET`/`DELETE datasets/{d}`, `GET datasets/{d}/operations/{op}`.
- `POST datasets/{d}/fhirStores?fhirStoreId=` (`version: R4`, `enableUpdateCreate`), `GET`, list, `PATCH ?updateMask=enableUpdateCreate,labels`, `DELETE`, `:export`, `:import` (no Cloud Storage access).

## FHIR

`.../fhirStores/{s}/fhir/...`: full FHIR R4, isolated per store. `PUT` to a missing id is `404` unless `enableUpdateCreate` is true. The default store has it on and holds the synthetic patients.

Docs: https://www.emuhealth.dev/docs/gcphealthcare
