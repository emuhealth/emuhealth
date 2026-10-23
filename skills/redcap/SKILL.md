---
name: redcap
description: Emulated REDCap API for local development and testing of research data integrations. Use when the user needs to export or import REDCap records, read a data dictionary (metadata), test filterLogic, or exercise code that calls a REDCap /api/ endpoint. Triggers include "REDCap", "REDCap API", "data dictionary", "record export", "PyCap", "REDCapR", or any task needing a local REDCap project.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# REDCap API Emulator

The REDCap `POST /api/` endpoint for a synthetic classic project.

## Start

```bash
npx emuhealth --service redcap
curl -X POST http://localhost:4108/api/ -d token=5E7E0000000000000000000000000001 -d content=metadata -d format=json
```

Default token `5E7E0000000000000000000000000001` (or `redcap.tokens`). Wrong token: `403`. `format` json, csv, or xml (default xml); errors follow `returnFormat`.

## Content

- `version`, `project`, `metadata` (`fields[]`, `forms[]`), `instrument`, `exportFieldNames`, `generateNextRecordName`.
- `content=record` export: `records[]`, `fields[]`, `forms[]`, `filterLogic` (`[sbp] >= 140 and [sex] = '1'`), `rawOrLabel=label`, `type=eav`.
- `content=record&action=import`: `data` as JSON array or CSV; validated against the dictionary; `overwriteBehavior`, `forceAutoNumber=true`, `returnContent=count|ids|auto_ids`.
- `content=record&action=delete&records[0]=1`: returns the count.

Fields: `record_id`, `dob`, `sex` (1 Female, 2 Male), `race___1`..`race___5`, `height`, `weight`, `bmi`, `demographics_complete`, `visit_date`, `sbp`, `dbp`, `medication` (0 to 3), `adverse_event`, `ae_description`, `visit_complete`.

## Seed config

```yaml
redcap:
  tokens: ["5E7E0000000000000000000000000001"]
  generate: { records: 20, seed: 1 } # or false
  records:
    - { record_id: "100", sex: "1", sbp: "128" }
```

Docs: https://www.emuhealth.dev/docs/redcap
