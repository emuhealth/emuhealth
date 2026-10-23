# 0014: Vendor layers over fhir-core

- Status: Accepted
- Date: 2026-10-23
- Refines: [0003](0003-fhir-r4-baseline.md), [0008](0008-fhir-core-design.md)

## Context

Phase 2 adds EHR vendors (Epic first, then Oracle Health, athenahealth, Blue Button). Each one speaks FHIR R4 with SMART, so most of the behavior already exists in `@emuhealth/fhir-core`. What differs is the URL shape, the OAuth paths, a few response quirks, and proprietary endpoints. Copying the server per vendor would let them drift apart and lose the Inferno gate ([0013](0013-inferno-acceptance-gate.md)).

## Decision

- Each vendor is its own package (`packages/@emuhealth/<vendor>`) and its own service with its own port and store. It calls `registerFhirRoutes` with the vendor's `basePath`, OAuth `smart.paths`, `software`, and `description`, and reuses the fhir seed config keys (`generate`, `resources`, `smart`, `terminology`) under its own config key.
- Vendor quirks go through small, general hooks in fhir-core rather than forks of its routes:
  - `smart.tokenExtras` adds fields to token responses (Epic's `__epic.dstu2.patient`).
  - `searchBundle` adjusts search result Bundles (Epic's informational OperationOutcome on empty results).
- Proprietary endpoints (Epic's `Appointment/$find` and `$book`) are routes in the vendor package, registered before the FHIR routes, and use `resolveAccess` so SMART scopes still apply.
- Vendor packages bundle fhir-core and test against its source.
- Docs, the CapabilityStatement, and the skill say the emulator is not affiliated with the vendor. Vendor identifiers that are only code system names (such as Epic's OperationOutcome detail code system) are used as published; real customer OIDs and identifiers are not.

## Consequences

- Fixes and conformance work in fhir-core reach every vendor.
- A quirk that the hooks cannot express needs a new hook in fhir-core, which keeps the shared server honest about what it allows.
- Vendor services do not share data with the `fhir` service. Each starts from the same generated population.
