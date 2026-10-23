---
name: epic
description: Emulated Epic FHIR R4 API for local development and testing of apps that connect to Epic. Use when the user is building or testing an Epic integration, a SMART on FHIR app for Epic, Epic OAuth 2.0 or backend services auth, or Epic scheduling with Appointment $find and $book. Triggers include "Epic", "Epic FHIR", "Epic on FHIR", "MyChart app", "api/FHIR/R4", "__epic.dstu2.patient", or any task needing a local Epic sandbox.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Epic FHIR R4 Emulator

The full emuhealth FHIR R4 server served the way Epic serves it. emuhealth is not affiliated with Epic.

**Synthetic data only.** Never load real patient data or other protected health information (PHI).

## Start

```bash
npx emuhealth --service epic
# FHIR base: http://localhost:4101/api/FHIR/R4
```

It starts with the same 5 generated synthetic patients as the `fhir` service (`Patient/syn-patient-001` and up), plus a Schedule and weekday Slots for each practitioner.

## Epic specifics

| Feature | Detail |
|---------|--------|
| FHIR base | `/api/FHIR/R4`; anything outside it is a `404` OperationOutcome |
| OAuth 2.0 | `/oauth2/authorize`, `/oauth2/token`, `/oauth2/introspect`, `/oauth2/revoke`; discovery at `/api/FHIR/R4/.well-known/smart-configuration` |
| Token response | `patient` and `__epic.dstu2.patient` when a patient is in context |
| Empty search | Bundle `total: 0` with an OperationOutcome entry (`search.mode: outcome`, detail code `4101`) |
| EHR launch | `/api/FHIR/R4/auth/launch?launch_uri=<app launch URL>&patient=<id>` |
| Scheduling | `POST /api/FHIR/R4/Appointment/$find` (`patient`, `startTime`, `endTime`) returns proposed Appointments; `POST /api/FHIR/R4/Appointment/$book` (`appointment`, optional `patient`, `appointmentNote`) books one and marks its Slot `busy`; `409` if taken |

Everything from the `fhir` skill (search, Bundles, `$everything`, Bulk Data, SMART scopes and enforcement, Backend Services, terminology) works the same under `/api/FHIR/R4`.

## Seed config

```yaml
epic:
  generate: { patients: 5, seed: 1 }
  smart:
    clients:
      - client_id: my-epic-app
        redirect_uris: ["http://localhost:3000/callback"]
  scheduling:
    startDate: "2026-11-02" # default today
    days: 10
```

Docs: https://www.emuhealth.dev/docs/epic
