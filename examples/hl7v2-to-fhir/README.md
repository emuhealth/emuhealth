# HL7 v2 feed into FHIR

An interface bridge that listens for HL7 v2 messages over MLLP, writes them to a FHIR server, and acknowledges each one. ADT messages create or update a Patient keyed by MRN (PID-3). ORU results also add one Observation per OBX. Errors are acknowledged with `AE`.

Two emuhealth emulators stand in for the hospital: the HL7 v2 emulator sends the feed, and the FHIR server receives the data. The bridge has no dependencies; the ER7 and MLLP handling is in `src/hl7.ts`.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then, in this folder:

```bash
npm run emulators   # npx emuhealth start --service fhir,hl7v2
npm start           # the bridge on MLLP port 2576
```

Send a synthetic admission through the bridge with the HL7 v2 emulator, then find the patient in FHIR:

```bash
MSG=$(curl -s 'http://localhost:4125/samples/adt-a01?patient=mrn-demo-1')
curl -s -X POST http://localhost:4125/send -H 'Content-Type: application/json' \
  -d "$(jq -n --arg m "$MSG" '{port: 2576, message: $m}')"
curl -s 'http://localhost:4100/Patient?identifier=urn:emuhealth:example:mrn|mrn-demo-1'
```

`npm test` runs the same flow in process: an admit, a lab result, and an update, then checks the Patient, the Observations, and the feed's ACK log.

The data is synthetic.
