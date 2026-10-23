---
name: cerner
description: Emulated Oracle Health (Cerner) Millennium FHIR R4 API for local development and testing of apps that connect to Millennium. Use when the user is building a SMART on FHIR app for Oracle Health or Cerner, testing tenant URLs, provider or patient persona OAuth, system account client credentials, or Millennium search requirements. Triggers include "Oracle Health", "Cerner", "Millennium", "fhir-ehr.cerner.com", "Cerner code console", or any task needing a local Cerner sandbox.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Oracle Health (Cerner) Millennium Emulator

The full emuhealth FHIR R4 server under Millennium's tenant URL shape. Not affiliated with Oracle.

## Start

```bash
npx emuhealth --service cerner
# FHIR base: http://localhost:4109/r4/5e7e0000-0000-4000-8000-000000000001
```

Same synthetic patients as the `fhir` service (`syn-patient-001` and up).

## Millennium specifics

| Feature | Detail |
|---------|--------|
| FHIR base | `/r4/5e7e0000-0000-4000-8000-000000000001` (one synthetic tenant) |
| OAuth | `/tenants/{tenant}/protocols/oauth2/profiles/smart-v1/personas/provider/authorize`, `.../personas/patient/authorize` (redirects to the same flow), `.../token` |
| Token response | adds `tenant`, plus `username` and `user` for a practitioner |
| System accounts | `client_credentials` with Basic auth for clients registered with `client_secret` |
| Required search params | Observation, Condition, and other clinical types need `patient`, `subject`, or `_id`; Patient needs an identifying parameter; otherwise `400` OperationOutcome |

Everything from the `fhir` skill works under the FHIR base.

## Seed config

```yaml
cerner:
  smart:
    clients:
      - { client_id: my-millennium-app, redirect_uris: ["http://localhost:3000/callback"] }
      - { client_id: my-system-account, client_secret: synthetic-secret, scope: system/Patient.read }
```

Docs: https://www.emuhealth.dev/docs/cerner
