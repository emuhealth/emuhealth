# Eligibility to claim status with Stedi

A clinic's billing flow through a clearinghouse with Stedi's JSON APIs: check a member's eligibility (270/271), submit a professional claim (837P), follow its status (276/277), and read the remittance (835). It runs against the emuhealth Stedi emulator, which adjudicates claims at once with synthetic rules, and has no dependencies; the API calls are in `src/billing.ts`.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emuhealth... build`. Then, in this folder:

```bash
npm run emulator   # npx emuhealth start --service stedi, on http://localhost:4117
npm start          # runs the flow for member SYNM000001
```

`npm test` runs the flow in process and checks the 80% payment and the contractual adjustments on the 835.

Claims use HCPCS Level II codes; emuhealth does not bundle CPT. The members and payers are synthetic. emuhealth is not affiliated with Stedi.
