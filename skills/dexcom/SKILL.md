---
name: dexcom
description: Emulated Dexcom API v3 for local development and testing of continuous glucose monitoring (CGM) apps. Use when the user integrates Dexcom OAuth, reads EGVs (glucose readings), events, devices, or data range, or tests CGM features. Triggers include "Dexcom", "CGM", "continuous glucose", "EGV", "glucose readings", "G7", or any task needing a local Dexcom sandbox.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Dexcom API v3 Emulator

Dexcom OAuth and v3 data for synthetic G7 users. Not affiliated with Dexcom.

## Start

```bash
npx emuhealth --service dexcom
# http://localhost:4119 (use instead of https://sandbox-api.dexcom.com)
```

## OAuth

`GET /v2/oauth2/login?client_id=&redirect_uri=&response_type=code&scope=offline_access` shows a consent page; pick a synthetic user. `POST /v2/oauth2/token` (form: grant_type=authorization_code, code, client_id, client_secret, redirect_uri) returns `access_token` (7200 s) and `refresh_token`.

## Data (Bearer token)

- `GET /v3/users/self/egvs?startDate=2025-03-04T00:00:00&endDate=2025-03-04T06:00:00`: 5 minute readings (`value` mg/dL, `trend`, `trendRate`), max 30 days, else `400`.
- `GET /v3/users/self/events`, `/devices`, `/alerts`, `/calibrations`, `/dataRange`.
- Bad token: `401 {"fault":{"faultstring":"Invalid Access Token"}}`.

Glucose is deterministic per user and time, with meal peaks after 08:00, 13:00, and 19:00 UTC.

## Seed config

```yaml
dexcom:
  clients: [{ client_id: my-dexcom-app, client_secret: synthetic-secret, redirect_uris: ["http://localhost:3000/callback"] }]
```

Docs: https://www.emuhealth.dev/docs/dexcom

Example: https://github.com/emuhealth/emuhealth/tree/main/examples/dexcom-to-fhir (CGM readings into FHIR Observations).
