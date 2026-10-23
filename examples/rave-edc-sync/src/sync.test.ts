import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { sync } from "./sync.ts";

const credentials = { username: "rws.synthetic", password: "synthetic-password" };

test("syncs the audit trail incrementally and picks up new data entry", async () => {
  const rave = await createEmulator({ service: "rave", port: 0 });
  const dir = mkdtempSync(join(tmpdir(), "rave-sync-"));
  const options = {
    raveUrl: rave.url,
    ...credentials,
    study: "EMU-101(Prod)",
    statePath: join(dir, "state.json"),
    perPage: 25,
  };
  try {
    // The first run pages through the whole trail, 25 records at a time.
    const first = await sync(options);
    assert.ok(first.applied > 25);
    assert.equal(Object.keys(first.state.subjects).length, 8);
    assert.ok(first.state.subjects["101-001"]["SCREENING/DM/DM.SEX"]);

    // Nothing new, nothing applied.
    assert.equal((await sync(options)).applied, 0);

    // A site enters a pulse through RWS, as an EDC integration would.
    const odm = `<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" xmlns:mdsol="http://www.mdsol.com/ns/odm/metadata" FileType="Transactional" FileOID="sync-example" CreationDateTime="2026-02-01T00:00:00" ODMVersion="1.3">
  <ClinicalData StudyOID="EMU-101 (Prod)" MetaDataVersionOID="1001">
    <SubjectData SubjectKey="101-001" TransactionType="Update">
      <SiteRef LocationOID="SYN-SITE-101" />
      <StudyEventData StudyEventOID="SCREENING">
        <FormData FormOID="VS" FormRepeatKey="1" TransactionType="Update">
          <ItemGroupData ItemGroupOID="VS"><ItemData ItemOID="VS.PULSE" Value="61" /></ItemGroupData>
        </FormData>
      </StudyEventData>
    </SubjectData>
  </ClinicalData>
</ODM>`;
    const post = await fetch(`${rave.url}/RaveWebServices/webservice.aspx?PostODMClinicalData`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      },
      body: odm,
    });
    assert.equal(post.status, 200, await post.text());

    const second = await sync(options);
    assert.equal(second.applied, 1);
    assert.equal(second.state.subjects["101-001"]["SCREENING/VS/VS.PULSE"], "61");
    assert.ok(second.state.nextStartId > first.state.nextStartId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await rave.close();
  }
});
