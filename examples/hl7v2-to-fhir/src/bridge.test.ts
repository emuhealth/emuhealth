import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { createBridge } from "./bridge.ts";

test("ADT and ORU messages from the HL7 v2 emulator land in the FHIR server", async () => {
  // The HL7 v2 emulator plays the hospital feed: its /send route delivers messages over MLLP and returns the ACK.
  const feed = await createEmulator({ service: "hl7v2", port: 0, seed: { hl7v2: { mllp: false } } });
  const fhir = await createEmulator({ service: "fhir", port: 0 });
  const bridge = createBridge({ fhirBase: fhir.url });
  try {
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const port = (bridge.address() as AddressInfo).port;
    const send = async (kind: string) => {
      const message = await (await fetch(`${feed.url}/samples/${kind}?patient=mrn-bridge-1`)).text();
      const res = await fetch(`${feed.url}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "127.0.0.1", port, message }),
      });
      const body = (await res.json()) as { ackCode: string; ack: string };
      return body;
    };

    assert.equal((await send("adt-a01")).ackCode, "AA");
    assert.equal((await send("oru-r01")).ackCode, "AA");
    // A second admit updates the same Patient instead of creating another.
    assert.equal((await send("adt-a08")).ackCode, "AA");

    const patients = (await (
      await fetch(`${fhir.url}/Patient?identifier=urn:emuhealth:example:mrn|mrn-bridge-1`)
    ).json()) as any;
    assert.equal(patients.total, 1);
    const patient = patients.entry[0].resource;
    assert.equal(patient.name[0].family, "SYNTHETIC");

    const observations = (await (await fetch(`${fhir.url}/Observation?subject=Patient/${patient.id}`)).json()) as any;
    assert.equal(observations.total, 2);
    const glucose = observations.entry.find((e: any) => e.resource.code.coding[0].code === "2345-7").resource;
    assert.deepEqual(glucose.valueQuantity, {
      value: 95,
      unit: "mg/dL",
      system: "http://unitsofmeasure.org",
      code: "mg/dL",
    });

    // The feed's message log shows the bridge's ACKs.
    const log = (await (await fetch(`${feed.url}/messages`)).json()) as any;
    assert.equal(log.messages.length, 3);
  } finally {
    bridge.close();
    await feed.close();
    await fhir.close();
  }
});
