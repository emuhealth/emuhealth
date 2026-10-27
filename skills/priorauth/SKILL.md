---
name: priorauth
description: Emulated Da Vinci prior authorization services (CRD, DTR, PAS) of a synthetic payer, for local development and testing. Use when the user builds or tests coverage requirements discovery, documentation templates, or prior authorization submission against a payer. Triggers include "prior authorization", "CRD", "DTR", "PAS", "Da Vinci", "Claim/$submit", "coverage-information", "questionnaire-package", or any task needing a local prior auth payer.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Prior Authorization Emulator

A synthetic payer on `http://localhost:4129`.

```bash
npx emuhealth --service priorauth
curl http://localhost:4129/cds-services
```

- Rules by HCPCS: `E0601` CPAP (PA, questionnaire `home-cpap`, pended then approved on `$inquire`), `E1390` oxygen (PA, `home-oxygen`, approved), `K0001` wheelchair (no PA, approved), `E0260` hospital bed (PA, `hospital-bed`, denied).
- CRD: `POST /cds-services/coverage-requirements-order-sign` with `context.draftOrders` (DeviceRequest/ServiceRequest with HCPCS `codeCodeableConcept`) and `prefetch.coverage`: systemActions add `ext-coverage-information` (covered, pa-needed, doc-needed, questionnaire); cards link the questionnaire.
- DTR: `POST /fhir/Questionnaire/$questionnaire-package` with Parameters `coverage` and `order`: PackageBundle with the Questionnaire.
- PAS: `POST /fhir/Claim/$submit` with a Bundle whose Claim has `use: preauthorization` and an identifier: ClaimResponse `outcome` complete, queued, partial, or error, `preAuthRef` when approved, item decisions in `urn:emuhealth:extension:priorauth-review-decision` (X12 codes are licensed). `POST /fhir/Claim/$inquire` returns the current decision.

Not affiliated with any payer. Docs: https://www.emuhealth.dev/docs/priorauth
