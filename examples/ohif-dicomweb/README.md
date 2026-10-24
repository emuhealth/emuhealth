# OHIF Viewer on the DICOMweb emulator

Browse and view emuhealth's synthetic CT and MR studies in the [OHIF Viewer](https://ohif.org). `app-config.js` points OHIF's DICOMweb data source at the emulator on `http://localhost:4124` (QIDO-RS for the study list, WADO-RS for metadata and frames), and `docker-compose.yml` runs OHIF with it.

Requires Node 24 or later and Docker. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then, in this folder:

```bash
npm run emulator      # npx emuhealth start --service dicomweb
docker compose up     # OHIF on http://localhost:3000
```

Open `http://localhost:3000` to see the study list and open a study.

`npm test` checks, without Docker, that the emulator answers the requests OHIF makes: the study list query with `includefield` and fuzzy matching, series and series metadata with BulkDataURIs, and frames as `multipart/related` with CORS.

The images are synthetic phantoms. emuhealth is not affiliated with OHIF.
