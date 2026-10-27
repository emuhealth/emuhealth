import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { checkEligibility, claimStatus, remittance, submitClaim } from "./billing.ts";

test("eligibility, claim, status, and remittance for a synthetic member", async () => {
  const stedi = await createEmulator({ service: "stedi", port: 0 });
  const ch = { baseUrl: stedi.url, apiKey: "test_synthetic_key" };
  try {
    const eligibility = await checkEligibility(ch, "SYN01", "SYNM000001");
    assert.equal(eligibility.active, true);
    assert.ok(eligibility.subscriber.lastName);

    const unknown = await checkEligibility(ch, "SYN01", "SYNM999999");
    assert.equal(unknown.active, false);

    const pcn = await submitClaim(ch, "SYN01", eligibility.subscriber, {
      controlNumber: "PCN-EXAMPLE-1",
      date: "20260115",
      diagnosis: "I10",
      lines: [
        { code: "G0439", charge: 135.75 },
        { code: "G0008", charge: 25 },
      ],
    });
    assert.equal(pcn, "PCN-EXAMPLE-1");

    const status = await claimStatus(ch, "SYN01", eligibility.subscriber, pcn, "20260115");
    assert.equal(status.category, "F1");
    assert.equal(status.submitted, 160.75);
    // SYN01 pays 80% of the charge.
    assert.equal(status.paid, 128.6);

    const era = await remittance(ch, pcn);
    assert.equal(era.paid, 128.6);
    assert.deepEqual(era.adjustments, [27.15, 5]);
  } finally {
    await stedi.close();
  }
});
