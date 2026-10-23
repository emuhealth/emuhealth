---
name: cdshooks
description: CDS Hooks emulator for building and testing clinical decision support services locally. Use when the user is writing a CDS Hooks service, needs an EHR to fire patient-view or order-sign at it, wants to validate cards, test prefetch and fhirAuthorization, verify EHR JWTs, or needs sample CDS services to call. Triggers include "CDS Hooks", "cds-services", "patient-view", "order-sign", "CDS card", "clinical decision support service", or any task needing a local CDS Hooks EHR.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# CDS Hooks Emulator

A simulated EHR that calls your CDS service, plus sample services.

## Start

```bash
npx emuhealth --service cdshooks
curl -X POST http://localhost:4112/ehr/fire -H 'Content-Type: application/json' \
  -d '{"discoveryUrl":"http://localhost:3000/cds-services","hook":"order-sign","patientId":"syn-patient-002","medication":"amoxicillin 500 MG Oral Capsule"}'
```

Or use the form at `http://localhost:4112/_inspector`.

## What the EHR sends

- `Authorization: Bearer <JWT>` (RS384, `iss` http://localhost:4112, `aud` your service URL, `jti`, `jku` = http://localhost:4112/.well-known/jwks.json).
- `hook`, `hookInstance`, `fhirServer` = http://localhost:4112/fhir (synthetic FHIR R4), `fhirAuthorization` (patient/*.read Bearer token, 5 minutes).
- `context`: `userId`, `patientId`, `encounterId`; `draftOrders` and `selections` for order hooks.
- `prefetch` filled from your discovery templates (`{{context.patientId}}`, `{{context.encounterId}}`, `{{userPractitionerId}}`).

`/ehr/fire` returns `{ request, status, response, issues }`; `issues` lists card rule violations (summary 140 chars, indicator info|warning|critical, source.label, link type, action type, selectionBehavior). `GET /ehr/invocations` for history.

## Sample services

`GET /cds-services`: `patient-greeting` (patient-view, info card) and `allergy-check` (order-sign, warning with a delete suggestion). `POST /cds-services/{id}/feedback`.

Docs: https://www.emuhealth.dev/docs/cdshooks
