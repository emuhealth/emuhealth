# SMART on FHIR app against Epic

A small web app that signs in with SMART App Launch (standalone launch, PKCE) against the emuhealth Epic emulator and shows the patient's name, conditions, and medications. It uses only `fetch` and `node:http`, so every step of the protocol is visible in `src/smart.ts`.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then, in this folder:

```bash
npm run emulator   # npx emuhealth start --service epic, on http://localhost:4101
npm start          # the app on http://localhost:3000
```

Open `http://localhost:3000/launch`, pick a synthetic practitioner and patient, and the app shows that patient's summary.

To point the app at a real Epic sandbox later, set `FHIR_BASE` to its FHIR base URL and register your own client ID and redirect URI with Epic.

`npm test` runs the whole flow without a browser: it starts the emulator with `createEmulator`, starts the app, submits the sign in forms, and checks the summary page.

The data is synthetic. emuhealth is not affiliated with Epic.
