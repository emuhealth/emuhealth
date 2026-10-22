---
name: fhir
description: Emulated FHIR R4 server for local health app development and testing. Use when the user needs a local FHIR server, wants to create, read, update, patch, or delete FHIR resources (Patient, Observation, Encounter, and any other R4 type), test versioning with ETag and If-Match, read _history, seed synthetic patients, or point a FHIR client at localhost. Triggers include "FHIR server", "FHIR R4", "local FHIR", "emulate FHIR", "Patient resource", "fhirclient", "HAPI", or any task requiring a local FHIR API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# FHIR R4 Server Emulator

Stateful FHIR R4 (4.0.1) server. Resources and every version of them persist in memory. Any R4 resource type is accepted.

**Synthetic data only.** Never load real patient data or other protected health information (PHI). Generate synthetic records for seeds and tests.

## Start

The FHIR service is a health service, so its default port is 4100 (base port + 100) no matter which other services run.

```bash
npx emuhealth --service fhir
# http://localhost:4100
```

Or programmatically:

```typescript
import { createEmulator } from 'emuhealth'

const fhir = await createEmulator({ service: 'fhir' })
// fhir.url === 'http://localhost:4100'
```

## Endpoints

The FHIR base URL is the server root. Send and expect `application/fhir+json` (`application/json` is also accepted for writes).

| Interaction | Request |
|-------------|---------|
| create | `POST /:type` (server assigns the id) |
| read | `GET /:type/:id` |
| vread | `GET /:type/:id/_history/:vid` |
| update | `PUT /:type/:id` (creates the resource when the id does not exist; body `id` must match the URL) |
| patch | `PATCH /:type/:id` with `Content-Type: application/json-patch+json` |
| delete | `DELETE /:type/:id` (logical; later reads return `410 Gone`) |
| history | `GET /:type/:id/_history`, `GET /:type/_history`, `GET /_history` with `_count` and `_since` |

Not available yet: search, `batch` and `transaction` Bundles, `/metadata`, SMART on FHIR. Requests are not authenticated until SMART support lands.

## Versioning

- Every write increments `meta.versionId` and sets `meta.lastUpdated`.
- Responses carry `ETag: W/"<versionId>"`; creates also carry `Location: <base>/<type>/<id>/_history/<versionId>`.
- `If-Match: W/"<versionId>"` on update, patch, or delete returns `412` when the version moved on.
- `If-None-Match` on read returns `304` when unchanged.
- `Prefer: return=minimal` returns an empty body.

```bash
# Create
curl -X POST http://localhost:4100/Patient \
  -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","name":[{"family":"Example","given":["Jamie"]}]}'

# Patch with a version check
curl -X PATCH http://localhost:4100/Patient/<id> \
  -H 'Content-Type: application/json-patch+json' \
  -H 'If-Match: W/"1"' \
  -d '[{"op":"replace","path":"/gender","value":"female"}]'
```

## Errors

Errors are `OperationOutcome` resources: `400` invalid input, `404` unknown id or resource type, `410` deleted, `412` version conflict, `415` unsupported content type, `422` failed JSON Patch `test`.

## Seed config

```yaml
fhir:
  resources:
    - resourceType: Patient
      id: synthetic-patient-1
      name:
        - family: Example
          given: [Jamie]
      gender: female
      birthDate: "1980-01-01"
```

Resources with an `id` keep it; others get a server-assigned id. Invalid resources stop startup with the failing index, for example `fhir.resources[0]`.
