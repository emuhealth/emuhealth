---
name: dicomweb
description: Emulated DICOMweb server (QIDO-RS, WADO-RS, STOW-RS) for local development and testing. Use when the user needs to search, retrieve, render, or upload DICOM studies, test a viewer or imaging pipeline against a DICOMweb endpoint, or replace Orthanc, dcm4chee, Google Cloud Healthcare DICOM stores, or Azure DICOM service in tests. Triggers include "DICOMweb", "QIDO", "WADO", "STOW", "DICOM", "PACS", "imaging study", or any task needing a local DICOM server.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# DICOMweb Emulator

QIDO-RS, WADO-RS, and STOW-RS (DICOM PS3.18) over synthetic CT and MR studies.

## Start

```bash
npx emuhealth --service dicomweb
# DICOMweb root: http://localhost:4124
```

## Search (QIDO-RS)

`GET /studies`, `/series`, `/instances`, `/studies/{study}/series`, `/studies/{study}/instances`, `/studies/{study}/series/{series}/instances`. Filters by keyword or tag (`PatientID`, `PatientName`, `StudyDate` ranges like `20260101-20260131`, `ModalitiesInStudy`, `Modality`, `AccessionNumber`, UIDs as comma lists, `*` and `?` wildcards), plus `fuzzymatching=true`, `includefield` (`all` on instances), `limit`, `offset`. Returns `application/dicom+json` with `RetrieveURL` and study and series counts.

```bash
curl 'http://localhost:4124/studies?ModalitiesInStudy=MR'
```

## Retrieve (WADO-RS)

- `GET /studies/{study}[/series/{series}[/instances/{instance}]]` returns `multipart/related; type="application/dicom"` Part 10 files.
- `.../metadata` returns DICOM JSON, with pixel data as a `BulkDataURI` (`.../bulkdata/7FE00010`).
- `.../instances/{instance}/frames/1,2` returns raw frames as `application/octet-stream` parts.
- `.../rendered`, `.../frames/{n}/rendered`, `.../thumbnail` return PNG (8 or 16 bit grayscale).
- An unsupported `Accept` returns `406`.

## Store (STOW-RS)

`POST /studies` or `/studies/{study}` with `multipart/related; type="application/dicom"; boundary=...` (Explicit or Implicit VR Little Endian). Responds with `00081199` (stored, with RetrieveURL) and `00081198` (failed, FailureReason `0xC000` unreadable, `0xA900` UID or study mismatch); status `200`, `202` (partial), or `409` (all failed). `DELETE` removes a study, series, or instance.

## Synthetic data

Three studies for `syn-patient-001` and onward (CT chest, MRI brain with two series, CT abdomen with two series), three 64x64 phantom images per series, `2.25` UIDs, accession numbers starting `SYNACC`. Browse at `/_inspector`.

## Seed config

```yaml
dicomweb:
  generate: { studies: 3, instancesPerSeries: 3, seed: emuhealth } # or false
  files: [./fixtures/synthetic-ct.dcm] # synthetic or deidentified only
  token: synthetic-token # optional; requires Authorization: Bearer
```

Docs: https://www.emuhealth.dev/docs/dicomweb
