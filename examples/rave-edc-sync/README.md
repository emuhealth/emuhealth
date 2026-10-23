# Incremental EDC sync from Rave

A sync job that keeps a local copy of a study's clinical data up to date by replaying Rave's audit trail (`ClinicalAuditRecords`). It saves a cursor (the next audit `startid`) with the snapshot, so each run only reads what changed since the last one, following the `Link: rel="next"` header across pages. This is how warehouse and CTMS integrations usually avoid re-reading whole studies.

It runs against the emuhealth Medidata Rave emulator and has no dependencies; the audit parsing is in `src/audit.ts`.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then, in this folder:

```bash
npm run emulator   # npx emuhealth start --service rave, on http://localhost:4127
npm run sync       # first run: reads the whole trail into rave-sync.json
npm run sync       # second run: nothing new
```

Enter data through RWS (see the [Rave docs](https://www.emuhealth.dev/docs/rave#importing-data)) and run `npm run sync` again to see only the new audit records applied.

`npm test` runs the whole story in process: a full first sync in pages of 25, an empty second sync, a `PostODMClinicalData` import, and a third sync that applies just that change.

The studies and subjects are synthetic. emuhealth is not affiliated with Medidata.
