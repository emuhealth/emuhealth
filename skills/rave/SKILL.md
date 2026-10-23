---
name: rave
description: Emulated Medidata Rave Web Services (RWS) for local development and testing. Use when the user needs to read Rave studies, subjects, clinical data, metadata, or audit records as CDISC ODM, post ODM clinical data, or test code built on rwslib or an EDC integration without a real Rave. Triggers include "Rave", "Medidata", "RWS", "rwslib", "EDC", "ODM clinical data", or any task needing a local Rave.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Medidata Rave (RWS) Emulator

Rave Web Services under `/RaveWebServices` with CDISC ODM 1.3 XML over synthetic studies.

## Start

```bash
npx emuhealth --service rave
curl -u rws.synthetic:synthetic-password http://localhost:4127/RaveWebServices/studies
```

HTTP Basic auth is required everywhere except `version`, `diagnostics`, and `twohundred`. A bad login returns 401 with `mdsol:ErrorDescription` ending in `[RWS00008]`.

## Read

- `GET /studies` returns `EMU-101`, `EMU-101(UAT)`, `EMU-202` and `EMU-202(UAT)`.
- `GET /metadata/studies/EMU-101/versions` lists CRF versions. `.../versions/1001` returns the full ODM metadata: folders SCREENING, BASELINE, WEEK4, LOGS; forms DM, VS, AE; fields like `VS.PULSE`.
- `GET /studies/EMU-101(Prod)/subjects?status=all&links=all&subjectKeyType=SubjectUUID`.
- `GET /studies/EMU-101(Prod)/datasets/regular[/VS]` returns clinical data. The same works under `/subjects/{key}/` and `/versions/{oid}/`. `start=` filters by change time.
- `GET /datasets/ClinicalAuditRecords.odm?studyoid=EMU-101(Prod)&startid=1&per_page=500` pages with a `Link: rel="next"` header.

## Write

`POST /webservice.aspx?PostODMClinicalData` with ODM `ClinicalData`:

- `SubjectData` takes `TransactionType` Insert (needs `SiteRef`, e.g. `SYN-SITE-101`), Update, Upsert, Context or Remove;
- inside it, `StudyEventData`, `FormData`, `ItemGroupData` and `ItemData`.

Values are type-checked. The import is all or nothing.

- Success returns `<Response IsTransactionSuccessful="1" SuccessStatistics="Rave objects touched: ..."/>`.
- Failure returns 400 with `ErrorClientResponseMessage`, `ErrorOriginLocation` and a `ReasonCode`: `RWS00024` for a subject that already exists, otherwise an emulator code (`EMU001` to `EMU011`).

## Seed config

```yaml
rave:
  users: [{ username: rws.synthetic, password: synthetic-password }]
  generate: { subjects: 8, seed: emuhealth } # or false
```

Not affiliated with Medidata. Docs: https://www.emuhealth.dev/docs/rave

Example: https://github.com/emuhealth/emuhealth/tree/main/examples/rave-edc-sync (incremental sync from `ClinicalAuditRecords` with a saved `startid`).
