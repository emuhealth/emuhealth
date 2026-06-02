---
name: fhir
description: FHIR R4 healthcare API emulator. Use when configuring local Patient, Observation, Encounter, Practitioner, Coverage, Claim, DiagnosticReport, or SMART on FHIR discovery flows with npx emulate.
allowed-tools: Bash(npx emulate:*)
---

# FHIR Emulation

Use the FHIR emulator for local healthcare and life-science integration tests that need FHIR R4 JSON resources.

## Start

```bash
npx emulate --service fhir
```

## Endpoints

- `GET /metadata` returns a FHIR R4 CapabilityStatement
- `GET /.well-known/smart-configuration` returns SMART on FHIR discovery metadata
- `GET /:resourceType` returns a FHIR searchset Bundle
- `POST /:resourceType` creates a FHIR resource
- `GET /:resourceType/:id` reads a FHIR resource
- `PUT /:resourceType/:id` replaces a FHIR resource
- `DELETE /:resourceType/:id` deletes a FHIR resource

## Seed Config

```yaml
fhir:
  resources:
    - resourceType: Patient
      id: pat-001
      name:
        - family: Rivera
          given: [Avery]
    - resourceType: Observation
      id: obs-001
      status: final
      subject:
        reference: Patient/pat-001
```
