---
name: redox
description: Emulated Redox API for local development and testing of Redox integrations. Use when the user sends or receives Redox JSON data models (PatientSearch, ClinicalSummary, PatientAdmin, Scheduling, Results), authenticates with Redox API keys, or builds a Redox destination endpoint that checks the verification token. Triggers include "Redox", "Redox data model", "redoxengine", "Redox destination", "verification-token", or any task needing a local Redox environment.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Redox Emulator

Redox `/endpoint` data models and destination webhooks over synthetic records. Not affiliated with Redox.

## Start

```bash
npx emuhealth --service redox
# http://localhost:4113
```

## Auth

`POST /auth/authenticate {"apiKey","secret"}` returns `accessToken` (any pair unless `redox.sources` is set); `POST /auth/refreshToken`; `POST /v2/auth/token` (client_credentials). Use `Authorization: Bearer <accessToken>` on `/endpoint`.

## Send (`POST /endpoint`)

- `PatientSearch.Query` by `Patient.Identifiers` (MR `SYN-000002`, EHRID `syn-patient-002`) or `Demographics`.
- `ClinicalSummary.PatientQuery`: Problems, Medications, Allergies, Immunizations, VitalSigns.
- `PatientAdmin.NewPatient` / `PatientUpdate`; `Scheduling.New` / `Reschedule` / `Cancel` (by `Visit.VisitNumber`); `Results.New`, `Notes.New`.
- Errors: `400` with `Meta.Errors[{ID, Text, Type, Module}]`.

## Receive

```yaml
redox:
  destinations:
    - { url: http://localhost:3000/redox, verificationToken: synthetic-verification-token, dataModels: [Results] }
```

`POST /ehr/send {"DataModel":"Results","EventType":"New","patientId":"syn-patient-002"}` delivers with header `verification-token`. `POST /ehr/verify {"url","verificationToken"}` runs the challenge handshake.

Docs: https://www.emuhealth.dev/docs/redox
