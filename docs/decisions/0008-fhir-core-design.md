# 0008: fhir-core package design

- Status: Accepted
- Date: 2026-10-23
- Refines: [0003](0003-fhir-r4-baseline.md)

## Context

[0003](0003-fhir-r4-baseline.md) chose one shared FHIR R4 package that vendor emulators build on. Before writing it we need to settle how it is shaped, how it stores resources on top of the core `Store`, how it is served, and how it ships, because Phase 1 and every Phase 2 vendor depend on these choices.

## Decision

**One package, two roles.** `packages/@emuhealth/fhir-core` (`@emuhealth/fhir-core`) exports:

- A library: `registerFhirRoutes(app, store, options)` mounts a FHIR R4 REST API under a configurable `basePath`, and `getFhirStore(store)` gives typed access to the resource store. Vendor emulators (Epic, Oracle Health, and so on) call these with their own URL shape and add their quirks around them.
- A generic service: `fhirPlugin`, registered in `registry-health.ts` as the `fhir` service. It serves the API at the server root, so with the default base port the FHIR base URL is `http://localhost:4100`.

**Storage on the core `Store`.** FHIR ids are strings and resources are versioned, while core collections use numeric ids. The store keeps two collections:

- `fhir.resources`: the current version of every resource, indexed by `key` (`Type/id`) and `resource_type`. Deleted resources stay as tombstones so reads return `410 Gone` and version numbers continue after a re-create.
- `fhir.history`: every version, indexed by `key`, for `vread` and `_history`.

Using the core `Store` gives reset, snapshots, and persistence for free.

**Behavior.**

- Server-assigned ids are UUIDs. `meta.versionId` is a string counter starting at `1`, and `meta.lastUpdated` is set on every write.
- Responses use `application/fhir+json` and carry `ETag: W/"<versionId>"`, `Last-Modified`, and on create `Location: <base>/<Type>/<id>/_history/<versionId>`.
- `If-Match` on update, patch, and delete returns `412 Precondition Failed` on a version mismatch. `If-None-Match` on read returns `304 Not Modified`.
- `PUT` to an id that does not exist creates it (update as create). Delete is logical, and deleting a missing or deleted resource returns `204`.
- `PATCH` accepts JSON Patch (`application/json-patch+json`). FHIRPath Patch is not supported yet.
- History is available at the instance, type, and system level as a `history` Bundle, newest first, with `_count` and `_since`.
- Errors are `OperationOutcome` resources with the matching HTTP status.
- Resource types are checked against the FHIR R4 (4.0.1) resource type list. Resource content is not validated against profiles in this package; conformance is checked with Inferno later ([0003](0003-fhir-r4-baseline.md)).
- Authentication is not enforced until the SMART App Launch roadmap item adds it.

**Shipping.** The package is bundled into the CLI like the upstream emulators. It is marked `"private": true` until Phase 1 is complete, because npm trusted publishing can only be configured for a package that already exists. The release workflow skips private packages. Publishing it individually later needs one manual first publish by a maintainer and a new decision record.

## Consequences

- Vendor emulators reuse the routes and store and only add URL shapes, auth, and proprietary endpoints.
- Search, Bundles (`batch`, `transaction`), `CapabilityStatement`, `$everything`, Bulk Data, SMART, and the synthetic patient generator are separate roadmap items that build on this store.
- `pnpm-workspace.yaml` and the CLI bundle include `packages/@emuhealth/*`, which are fork-owned additions to upstream files.
