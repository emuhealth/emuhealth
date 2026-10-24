---
name: bluebutton
description: Emulated CMS Blue Button 2.0 API for local development and testing of Medicare claims apps. Use when the user is building a Blue Button app, testing beneficiary OAuth, or reading Medicare Coverage and ExplanationOfBenefit (claims) data. Triggers include "Blue Button", "BB2", "CMS claims API", "Medicare claims", "ExplanationOfBenefit", "CARIN", or any task needing a local Blue Button sandbox.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# CMS Blue Button 2.0 Emulator

Blue Button OAuth and read-only FHIR R4 for synthetic Medicare beneficiaries. Not affiliated with CMS.

## Start

```bash
npx emuhealth --service bluebutton
# http://localhost:4111
```

## OAuth

- `GET /v2/o/authorize/` shows a beneficiary picker (always; no practitioner); token response includes `patient`.
- `POST /v2/o/token/` (`authorization_code` with PKCE S256, `refresh_token`), `/v2/o/introspect/`, `/v2/o/revoke_token/`.
- `GET /v2/connect/userinfo` with the token: `sub`, `patient`, names.

## FHIR (`/v2/fhir`, token required, read-only)

- `Patient/{id}` (MBI identifier `http://hl7.org/fhir/sid/us-mbi`), `Coverage?beneficiary=` (Parts A, B, D), `ExplanationOfBenefit?patient=&type=...|CARRIER|PDE&service-date=`.
- Other types `404`; writes `405`; another beneficiary's data looks like `404`.

## Seed config

```yaml
bluebutton:
  generate: { patients: 5, seed: 1 }
  smart:
    clients: [{ client_id: my-blue-button-app, redirect_uris: ["http://localhost:3000/callback"] }]
```

Docs: https://www.emuhealth.dev/docs/bluebutton

CMS's Node SDK (`cms-bluebutton-sdk`): use `environment: "LOCAL"` and run the emulator on port 8000 (`bluebutton.port: 8000`) with a client that has a `client_secret`. `/v2/o/authorize` and FHIR searches work with or without a trailing slash.
