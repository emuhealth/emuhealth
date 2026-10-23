---
name: azurehealth
description: Emulated Azure Health Data Services FHIR services for local development and testing, with Entra ID token verification through the emuhealth Microsoft emulator. Use when the user calls an Azure FHIR service, tests Entra ID (Azure AD) client credentials for FHIR, or needs a local azurehealthcareapis.com FHIR endpoint. Triggers include "Azure Health Data Services", "Azure FHIR", "azurehealthcareapis", "Azure API for FHIR", "Entra ID FHIR token", or any task needing a local Azure FHIR service.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Azure Health Data Services Emulator

FHIR services at `http://localhost:4116/{workspace}-{fhirservice}`. Not affiliated with Microsoft.

## Start

```bash
npx emuhealth --service azurehealth
curl -H 'Authorization: Bearer test' http://localhost:4116/synthetic-fhir/Patient/syn-patient-001
```

Default service `synthetic-fhir` (synthetic patients). Bearer token required; `/metadata` public. `401` OperationOutcome with `WWW-Authenticate` otherwise.

## Entra ID with the Microsoft emulator

```yaml
azurehealth:
  entra: { issuer: http://localhost:4005/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0 }
microsoft:
  oauth_clients: [{ client_id: my-app, client_secret: my-secret, name: My app, redirect_uris: ["http://localhost:3000/cb"] }]
```

```bash
npx emuhealth --service microsoft,azurehealth
curl http://localhost:4005/oauth2/v2.0/token -d grant_type=client_credentials -d client_id=my-app -d client_secret=my-secret -d scope=http://localhost:4116/synthetic-fhir/.default
```

Tokens are checked for signature (issuer JWKS), issuer, expiry, and audience = the FHIR service URL.

## Seed config

```yaml
azurehealth:
  workspaces: [{ name: synthetic, fhirServices: [{ name: fhir, preload: true }] }]
```

Docs: https://www.emuhealth.dev/docs/azurehealth
