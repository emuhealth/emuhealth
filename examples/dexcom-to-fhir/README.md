# Dexcom CGM data into FHIR

A sync job that copies continuous glucose readings from the Dexcom API into a FHIR server: it connects with Dexcom's OAuth, reads estimated glucose values for a window, and writes them as FHIR Observations (LOINC `99504-3`, glucose in interstitial fluid) in one transaction. Each reading gets an identifier and a conditional create (`ifNoneExist`), so running the sync again adds nothing twice.

It runs against the emuhealth Dexcom and FHIR emulators and has no dependencies; the code is in `src/sync.ts`.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then `npm run emulators` in this folder starts both emulators, and `npm test` runs the whole flow: consent, token exchange, a one day sync, and a second sync that adds nothing.

The users and readings are synthetic. emuhealth is not affiliated with Dexcom.
