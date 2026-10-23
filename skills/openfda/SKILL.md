---
name: openfda
description: Emulated openFDA API (api.fda.gov) for local development and testing. Use when the user needs drug labels, adverse event reports (FAERS), or drug, device, or food recalls (enforcement reports) locally, or is building against the openFDA query language. Triggers include "openFDA", "api.fda.gov", "drug label API", "adverse events", "FAERS", "drug recalls", "enforcement reports", or any task needing a local openFDA.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# openFDA Emulator

openFDA endpoints and query language over synthetic datasets. None of the data is FDA data.

## Start

```bash
npx emuhealth --service openfda
# http://localhost:4102 (use instead of https://api.fda.gov)
```

## Endpoints

| Endpoint | Records |
|----------|---------|
| `GET /drug/label.json` | 8 synthetic labels (`openfda.generic_name`, `openfda.rxcui`, `indications_and_usage`, ...) |
| `GET /drug/event.json` | 300 synthetic adverse event reports (`safetyreportid`, `receivedate`, `serious`, `patient.reaction`, `patient.drug`) |
| `GET /drug/enforcement.json`, `/device/enforcement.json`, `/food/enforcement.json` | Synthetic recalls (`recall_number`, `classification`, `status`, `reason_for_recall`, `report_date`) |
| `GET /_inspector` | Browse the datasets |

## Query parameters

- `search=field:term` with `"phrases"`, `field.exact:"Value"`, `term*`, `field:[a TO b]`, `_exists_:field`, `_missing_:field`, `AND`, `OR`, `NOT`, parentheses. A space (`+`) between clauses is `OR`.
- `sort=field:asc|desc`, `count=field` (`.exact` counts whole values), `limit` (default 1, max 1000), `skip`.
- No matches: `404 {"error":{"code":"NOT_FOUND","message":"No matches found!"}}`. Bad query or `limit` over 1000: `400` `BAD_REQUEST`.

```bash
curl 'http://localhost:4102/drug/event.json?search=patient.drug.openfda.generic_name:lisinopril+AND+serious:1&limit=5'
curl 'http://localhost:4102/drug/event.json?count=patient.reaction.reactionmeddrapt.exact'
```

## Seed config

```yaml
openfda:
  generate: { seed: 1, events: 300 } # or false
  records:
    drug/label:
      - id: my-label-1
        openfda: { generic_name: ["EXAMPLEMAB"] }
```

Docs: https://www.emuhealth.dev/docs/openfda
