---
name: clinicaltrials
description: Emulated ClinicalTrials.gov API v2 for local development and testing. Use when the user needs to search or display clinical trials, build trial matching or recruitment features, or test code that calls clinicaltrials.gov/api/v2. Triggers include "ClinicalTrials.gov", "clinical trials API", "NCT id", "trial search", "study recruitment", or any task needing a local ClinicalTrials.gov API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# ClinicalTrials.gov API v2 Emulator

API v2 paths, parameters, and JSON shapes over synthetic studies (`NCT99` ids, never real trials).

## Start

```bash
npx emuhealth --service clinicaltrials
# http://localhost:4104/api/v2 (use instead of https://clinicaltrials.gov/api/v2)
```

## Endpoints

- `GET /api/v2/studies`: `query.cond`, `query.term`, `query.intr`, `query.titles`, `query.outc`, `query.spons`, `query.locn`, `query.id`; `filter.overallStatus`, `filter.ids`, `filter.advanced` (`AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL`); `sort=LastUpdatePostDate:desc`; `fields=NCTId,BriefTitle,OverallStatus`; `pageSize` (default 10, max 1000); `pageToken`; `countTotal=true`. Returns `{ studies, nextPageToken, totalCount }`.
- `GET /api/v2/studies/{nctId}`: one study; `404` text `NCT number X not found`.
- `GET /api/v2/version`, `GET /api/v2/stats/size`, `GET /_inspector`.

Errors are plain text with `400` or `404`, like the real API.

```bash
curl 'http://localhost:4104/api/v2/studies?query.cond=diabetes&filter.overallStatus=RECRUITING&fields=NCTId,BriefTitle&countTotal=true'
```

## Seed config

```yaml
clinicaltrials:
  generate: { studies: 60, seed: 1 } # or false
  studies:
    - protocolSection:
        identificationModule: { nctId: NCT99999999, briefTitle: My synthetic study }
        statusModule: { overallStatus: RECRUITING }
```

Docs: https://www.emuhealth.dev/docs/clinicaltrials
