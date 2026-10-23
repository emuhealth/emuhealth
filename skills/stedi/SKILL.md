---
name: stedi
description: Emulated Stedi healthcare clearinghouse APIs for local development and testing of revenue cycle features. Use when the user checks insurance eligibility (270/271), submits professional claims (837P), checks claim status (276/277), or reads 835 ERAs through Stedi. Triggers include "Stedi", "eligibility check", "270/271", "837P", "claim status", "276/277", "835", "ERA", "remittance", "clearinghouse", or any task needing a local payer.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Stedi Emulator

Stedi's 2024-04-01 JSON healthcare APIs with synthetic payers and members. Not affiliated with Stedi.

## Start

```bash
npx emuhealth --service stedi
# http://localhost:4117, header Authorization: <any key>
```

Payers `SYN01`, `SYN02`; members `SYNM000001` and up (see `/_inspector`).

## Endpoints

- `POST /2024-04-01/change/medicalnetwork/eligibility/v3`: 271 JSON with `planStatus`, `benefitsInformation` (active coverage, deductible, copay, coinsurance, out of pocket). Unknown member: `errors[0].code` `75`.
- `POST /2024-04-01/change/medicalnetwork/professionalclaims/v3/submission`: 837P JSON; `400` on missing fields or unbalanced charges; `SUCCESS` with `claimReference`; adjudicated at once (80% or 70% paid).
- `POST /2024-04-01/change/medicalnetwork/claimstatus/v2`: `claims[].claimStatus` `F1`/`65` paid, `F2` denied, `A4` not found.
- `GET /2023-08-01/transactions`, `GET /2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835`: 835 JSON with payments and `CO 45` adjustments.
- `GET /2024-04-01/payers`.

Use HCPCS Level II codes in examples (CPT is not bundled).

## Seed config

```yaml
stedi:
  apiKeys: [test_synthetic_key]
  webhooks: [{ url: http://localhost:3000/stedi/events }]
```

Docs: https://www.emuhealth.dev/docs/stedi
