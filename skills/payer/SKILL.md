---
name: payer
description: Emulated health plan interoperability APIs for local development and testing. Use when the user needs a CMS patient access API with CARIN Blue Button claims, PDex payer-to-payer member match, or a Plan-Net provider directory, or tests an app or payer integration without a real payer. Triggers include "patient access API", "CARIN", "Blue Button IG", "PDex", "payer-to-payer", "member match", "Plan-Net", "provider directory", or any task needing a local payer API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Payer API Emulator

A synthetic health plan on `http://localhost:4128`: patient access at `/fhir` (SMART token required), payer-to-payer `$member-match`, and a public Plan-Net directory at `/directory`.

```bash
npx emuhealth --service payer
TOKEN=$(curl -s -X POST http://localhost:4128/fhir/auth/token -d grant_type=client_credentials \
  -d client_id=synthetic-new-payer -d client_secret=synthetic-new-payer-secret -d scope=system/*.read | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:4128/fhir/ExplanationOfBenefit?patient=syn-patient-001'
```

- Members: generated patients with member ids `SYNM0000001` onward, Coverage `coverage-<patient>`, payer `Organization/syn-payer`, and professional ExplanationOfBenefit claims (CARIN profiles, HCPCS lines) plus clinical data.
- Default clients: `member-app` (public, redirect `http://localhost:3000/callback`) and `synthetic-new-payer` (secret `synthetic-new-payer-secret`).
- `POST /fhir/Patient/$member-match` with Parameters `MemberPatient`, `CoverageToMatch` (`subscriberId`), and an active `Consent`: 200 with `MemberIdentifier` and `MemberId`, or 422. Needs a `system/` token.
- `/directory`: networks, provider groups, locations, practitioners and roles (network-reference, newpatients), services, insurance plans, endpoint, affiliations. Read-only and public. `PractitionerRole?network=Organization/network-ppo`.

Not affiliated with any payer. Docs: https://www.emuhealth.dev/docs/payer
