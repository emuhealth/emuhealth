---
name: healthlake
description: Emulated AWS HealthLake for local development and testing. Use when the user creates or manages HealthLake FHIR datastores, calls the HealthLake FHIR data plane with SigV4, or uses the AWS SDK or CLI healthlake commands. Triggers include "HealthLake", "AWS HealthLake", "FHIR datastore", "healthlake SigV4", "CreateFHIRDatastore", or any task needing a local HealthLake.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*), Bash(aws:*)
---

# AWS HealthLake Emulator

Control plane and per-datastore FHIR R4 with real SigV4 verification. Not affiliated with AWS.

## Start

```bash
npx emuhealth --service healthlake
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY AWS_REGION=us-east-1
aws healthlake list-fhir-datastores --endpoint-url http://localhost:4114
```

## Control plane

`POST /` with `X-Amz-Target: HealthLake.<Op>`: `CreateFHIRDatastore` (R4, optional `PreloadDataConfig: {PreloadDataType: SYNTHEA}`), `DescribeFHIRDatastore`, `ListFHIRDatastores`, `DeleteFHIRDatastore`, `Start/Describe/ListFHIRImportJob(s)`, `Start/Describe/ListFHIRExportJob(s)` (complete immediately; no S3 access).

## Data plane

`http://localhost:4114/datastore/{id}/r4/` (full FHIR R4), SigV4 for service `healthlake`. Default datastore `5e7e0000000000000000000000000001` has the synthetic patients.

Errors: `403` `{ "__type": "InvalidSignatureException" | "UnrecognizedClientException" | "MissingAuthenticationTokenException" }`; `ResourceNotFoundException`, `ValidationException`.

## Seed config

```yaml
healthlake:
  region: us-east-1
  credentials: [{ accessKeyId: AKIAIOSFODNN7EXAMPLE, secretAccessKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY }]
  datastores: [{ name: synthetic, preload: true }]
```

Docs: https://www.emuhealth.dev/docs/healthlake
