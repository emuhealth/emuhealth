---
name: nppes
description: Emulated CMS NPPES NPI Registry API for local development and testing. Use when the user needs to look up healthcare providers by NPI, name, organization, specialty, or location, validate NPIs in a provider directory, or test code that calls npiregistry.cms.hhs.gov. Triggers include "NPI", "NPI Registry", "NPPES", "provider lookup", "provider directory", or any task needing a local NPI API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# NPPES NPI Registry Emulator

The NPI Registry API (`/api/?version=2.1`) over synthetic providers.

## Start

```bash
npx emuhealth --service nppes
# http://localhost:4106/api/ (use instead of https://npiregistry.cms.hhs.gov/api/)
```

## Search

`GET /api/?version=2.1&...` with `number`, `enumeration_type` (`NPI-1`, `NPI-2`), `first_name`, `last_name`, `organization_name` (trailing `*` after 2+ characters), `taxonomy_description`, `address_purpose`, `city`, `state`, `postal_code`, `country_code`, `limit` (max 200), `skip` (max 1000). Returns `{ result_count, results }`.

Errors: `{"Errors":[{"description":"Unsupported Version","field":"version","number":"17"}]}` without `version=2.1`; `No valid search criteria provided` (number `04`) without a search field.

```bash
curl 'http://localhost:4106/api/?version=2.1&taxonomy_description=family+medicine&state=IL'
```

Synthetic NPIs have valid check digits but start with 0 (never a real NPI). Taxonomy codes are `SYNTH...` placeholders because the NUCC taxonomy is not bundled.

## Seed config

```yaml
nppes:
  generate: { individuals: 40, organizations: 15, seed: 1 } # or false
  providers:
    - number: "0999999990"
      enumeration_type: NPI-1
      basic: { first_name: JAMIE, last_name: EXAMPLE, credential: M.D. }
```

Docs: https://www.emuhealth.dev/docs/nppes
