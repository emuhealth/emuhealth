// Runs the billing flow once against the Stedi emulator started with `npm run emulator`.
import { checkEligibility, claimStatus, remittance, submitClaim } from "./billing.ts";

const ch = {
  baseUrl: process.env.STEDI_URL ?? "http://localhost:4117",
  apiKey: process.env.STEDI_API_KEY ?? "test_synthetic_key",
};
const payer = "SYN01";
const eligibility = await checkEligibility(ch, payer, "SYNM000001");
console.log(`Eligibility: ${eligibility.active ? "active" : "inactive"}, office copay ${eligibility.copay ?? "n/a"}`);
const pcn = await submitClaim(ch, payer, eligibility.subscriber, {
  controlNumber: `PCN-${Date.now()}`,
  date: "20260115",
  diagnosis: "I10",
  lines: [{ code: "G0439", charge: 135.75 }],
});
const status = await claimStatus(ch, payer, eligibility.subscriber, pcn, "20260115");
console.log(
  `Claim ${pcn}: status ${status.category}, paid ${status.paid.toFixed(2)} of ${status.submitted.toFixed(2)}`,
);
const era = await remittance(ch, pcn);
console.log(`835: paid ${era.paid.toFixed(2)}, adjustments ${era.adjustments.map((a) => a.toFixed(2)).join(", ")}`);
