# 0010: SMART App Launch

- Status: Accepted
- Date: 2026-10-23
- Refines: [0003](0003-fhir-r4-baseline.md), [0008](0008-fhir-core-design.md)

## Context

[0003](0003-fhir-r4-baseline.md) names SMART App Launch (v1 and v2 scopes) and SMART Backend Services as part of the FHIR baseline. Real health apps connect to EHRs through SMART: they discover endpoints, send the user through an OAuth authorize step with a patient or practitioner picked in the EHR, exchange a code for a token that carries launch context, and are then limited to what their scopes allow.

The `fhir` service has no authentication today, and every test and quick-start flow relies on that. Adding SMART must not break them, but it must let SMART apps test real restrictions.

## Decision

### Where it lives

SMART is part of `@emuhealth/fhir-core`, served by the same server as the FHIR API, so vendor emulators get it with `registerFhirRoutes` and can rename the endpoints (`authorizePath`, `tokenPath`) to match the EHR they emulate. For the generic `fhir` service the endpoints sit under the FHIR base URL:

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/smart-configuration` | Discovery: endpoints, `capabilities`, scopes, PKCE methods |
| `GET /auth/authorize` | Authorization: pickers, then redirect with `code` |
| `POST /auth/token` | `authorization_code` and `refresh_token` grants (Backend Services adds `client_credentials`) |
| `POST /auth/introspect`, `POST /auth/revoke` | Token introspection and revocation |
| `GET /auth/launch` | EHR launch simulator (see below) |
| `GET /.well-known/jwks.json` | Public key for `id_token` signatures |

The CapabilityStatement adds the `SMART-on-FHIR` security service and the `oauth-uris` extension.

### Launch flows

- **Standalone launch:** `launch/patient` in the requested scopes shows a patient picker. `openid fhirUser` with `user/` scopes shows a practitioner picker first. The picked ids become the token's `patient` context and `fhirUser`.
- **EHR launch:** `GET /auth/launch?launch_uri=<app>&patient=<id>&encounter=<id>` (or the launch simulator page, which offers the pickers) creates a launch context and redirects to `<app>?iss=<base>&launch=<opaque id>`. The app then sends `launch=<id>` to `/auth/authorize`, and the context skips the pickers.
- Pickers and the launch simulator use the shared UI in `core/src/ui.ts` (`renderCardPage`, `renderUserButton`), as AGENTS.md requires. Patients show name, birth date, gender, and MRN. There is no consent screen; requested scopes are granted.

### Clients

- With no clients configured, any `client_id` and `redirect_uri` is accepted (public client), like the permissive defaults of the upstream OAuth emulators.
- `fhir.smart.clients` registers clients with `client_id`, optional `client_secret` (confidential clients), `redirect_uris`, and optional allowed `scope`. Once any client is configured, unknown clients and unregistered redirect URIs are rejected.
- PKCE: `code_challenge_method=S256` is verified when sent and required for public clients when `fhir.smart.requirePkce` is true (default true, as SMART v2 requires). `plain` is rejected.

### Tokens

- Access and refresh tokens are opaque random strings kept in the core `Store`, so reset and snapshots clear them. Access tokens live 1 hour; refresh tokens are issued for `offline_access` or `online_access`.
- The token response carries `scope`, `patient`, `encounter` (EHR launch), `need_patient_banner`, and `smart_style_url` when relevant.
- `openid fhirUser` adds an RS256 `id_token` with `fhirUser`, signed with a key generated at startup (`jose`, already used by core).

### Scopes and enforcement

- Both SMART v1 (`patient/Observation.read`, `user/*.write`, `.*`) and v2 (`patient/Observation.rs`, `cruds` subsets, and granular `?category=...` constraints) are parsed into one internal form: a context (`patient`, `user`, `system`), a resource type or `*`, a set of interactions (create, read, update, delete, search), and optional search constraints.
- **Permissive by default:** requests without a token keep full access, so quick start and existing tests work unchanged. A request that presents a SMART token is always held to it: interactions outside its scopes get `403` with an `OperationOutcome`, and `patient/` scopes limit reads, searches, history, `$everything`, and Bundle entries to that patient's compartment (resources outside it look like `404`, writes outside it get `403`). Invalid or expired tokens get `401` with `WWW-Authenticate: Bearer`.
- `fhir.smart.required: true` turns on strict mode: every FHIR request needs a valid token. `/metadata` and `/.well-known/smart-configuration` stay public.
- v2 granular constraints are enforced on search and read results; constraints on write interactions are out of scope for now.

### Delivery

Three pull requests, each with docs:

1. Discovery, authorize with pickers, EHR launch simulator, token endpoint with PKCE, refresh, introspect, revoke, and `id_token`. Tokens are issued but not yet enforced.
2. Scope and compartment enforcement on the FHIR routes, permissive and strict modes, CapabilityStatement security.
3. SMART Backend Services: `client_credentials` with a JWT client assertion verified against the client's JWKS (its own roadmap item).

The ONC Inferno SMART App Launch test kit becomes the acceptance gate later in Phase 1.

## Consequences

- SMART apps can be developed and tested end to end against `npx emuhealth --service fhir` without accounts or network.
- Existing users see no change unless they present SMART tokens or turn on `required`.
- Enforcement adds a check to every FHIR route; it lives in one place in `routes.ts` and `bundle.ts`, so vendor emulators inherit it.
- Permissive by default (chosen over requiring tokens by default, which would break quick start and `curl` use) means an app that forgets to send its token still works locally; teams that want production-like behavior set `required: true` in CI.
