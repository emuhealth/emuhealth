---
name: athena
description: Emulated athenahealth APIs (athenaOne proprietary REST and FHIR R4) for local development and testing. Use when the user is integrating with athenahealth, calling /v1/{practiceid} endpoints for patients, chart data, or appointments, using athenahealth OAuth client credentials, or the athenahealth FHIR API with ah-practice. Triggers include "athenahealth", "athenaOne", "athena API", "practiceid 195900", "ah-practice", or any task needing a local athenahealth sandbox.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# athenahealth Emulator

Proprietary REST and FHIR R4 over the same synthetic records. Not affiliated with athenahealth.

## Start

```bash
npx emuhealth --service athena
TOKEN=$(curl -s -u client:secret -d grant_type=client_credentials http://localhost:4110/oauth2/v1/token | jq -r .access_token)
```

Practice `195900` (or `athena.practiceIds`). Bearer token required everywhere.

## Proprietary API (`/v1/195900`)

- `GET departments`, `GET providers`
- `GET patients?lastname=&firstname=&dob=MM/DD/YYYY` (a criterion is required), `GET patients/{id}` (array), `POST patients` (form: firstname, lastname, dob, departmentid)
- `GET chart/{patientid}/problems|allergies|medications|vitals?departmentid=1`
- `GET appointments/open?departmentid=1&startdate=&enddate=`, `PUT appointments/{id}` (patientid) books, `GET appointments/booked?startdate=&enddate=`, `PUT appointments/{id}/cancel`

Lists: `{ <items>, totalcount, next }`, `offset` and `limit`. Errors: `{ "error": "..." }`. Patient `N` is FHIR `syn-patient-00N`.

## FHIR R4

`/fhir/r4`; searches need `ah-practice=Organization/a-1.Practice-195900`.

## Seed config

```yaml
athena:
  practiceIds: ["195900"]
  scheduling: { startDate: "2026-11-02", days: 10 }
```

Docs: https://www.emuhealth.dev/docs/athena
