---
name: availity
description: Emulated Availity HIPAA transaction APIs for local development and testing. Use when the user checks coverage (270/271), claim status (276/277), or service reviews / prior authorization (278) through Availity, handles Availity's asynchronous polling, or uses Availity Demo plan mock scenarios. Triggers include "Availity", "Availity API", "coverages", "claim-statuses", "service reviews", "X-Api-Mock-Scenario-ID", or any task needing a local Availity.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Availity Emulator

Availity's HIPAA transaction APIs under `http://localhost:4118/availity`, with synthetic data. Not affiliated with Availity. Response bodies follow the public guide's fields, not an exact schema.

## Start

```bash
npx emuhealth --service availity
TOKEN=$(curl -s http://localhost:4118/availity/v1/token -d grant_type=client_credentials -d client_id=a -d client_secret=b -d scope=hipaa | jq -r .access_token)
```

Tokens last 5 minutes. Payers `SYNAV1` (270, 276, 278) and `SYNAV2` (270, 276); members `AVM0000001` and up.

## Async inquiries

- `POST /availity/v1/coverages` (form: payerId, providerNpi, memberId, serviceType) returns `202 {id, statusCode: "0"}`; poll `GET /availity/v1/coverages/{id}` until `statusCode: "4"` (or `"6"` rejection).
- `GET /availity/v1/claim-statuses?payerId=&providerNpi=&memberId=` then poll `GET /availity/v1/claim-statuses/{id}`.
- `POST /availity/v2/service-reviews` (JSON) returns `202` + `Location`; `GET` it for `Approved`/`A1`; `DELETE` voids.
- `GET /availity/availity-payer-list`, `GET /availity/v1/configurations?type=270`.

Demo mocks: header `X-Api-Mock-Scenario-ID` (`Coverages-Complete-i`, `Coverages-InProgress-i`, `Coverages-Retrying-i`, `Coverages-RequestError1-i`, `SR-CreateRequestAccepted-i`, `SR-GetComplete-i`, `SR-GetPayerDown-i`, `SR-GetRetrying-i`).

## Seed config

```yaml
availity:
  pollsUntilComplete: 1
```

Docs: https://www.emuhealth.dev/docs/availity
