import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import {
  deframe,
  escape,
  frame,
  get,
  hl7v2Plugin,
  listen,
  parseMessage,
  receive,
  seedFromConfig,
  segment,
  sendMllp,
  unescape,
  DEFAULT_DELIMITERS,
  type Patient,
} from "../index.js";

const base = "http://localhost:4125";

function startService() {
  const app = new Hono();
  const store = new Store();
  hl7v2Plugin.register(app as never, store, new WebhookDispatcher(), base);
  hl7v2Plugin.seed?.(store, base);
  return { store, req: (path: string, init?: RequestInit) => app.request(`${base}${path}`, init) };
}

const msa = (ack: string) => {
  const m = parseMessage(ack);
  return {
    code: get(m, segment(m, "MSA"), 1),
    control: get(m, segment(m, "MSA"), 2),
    text: get(m, segment(m, "MSA"), 3),
  };
};

const adt = (trigger: string, extra: string[] = [], control = `C${trigger}`) =>
  [
    `MSH|^~\\&|SYN_EHR|SYN_HOSP|EMUHEALTH|EMUHEALTH|20260101120000||ADT^${trigger}^ADT_A01|${control}|P|2.5.1`,
    `EVN|${trigger}|20260101120000`,
    "PID|1||syn-mrn-900^^^SYN^MR||SYNTHETIC^TAYLOR^Q||19850505|F|||1 SAMPLE WAY^^SPRINGFIELD^IL^62701",
    ...extra,
  ].join("\r");

describe("ER7 and MLLP", () => {
  it("parses fields, components, repetitions, and escapes", () => {
    const m = parseMessage("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|X1|P|2.5\rPID|1||a^^^X^MR~b^^^Y^PI||DOE\\S\\JR^SAM");
    expect(get(m, segment(m, "MSH"), 1)).toBe("|");
    expect(get(m, segment(m, "MSH"), 9, 2)).toBe("A01");
    expect(get(m, segment(m, "PID"), 3, 1, 1)).toBe("b");
    expect(get(m, segment(m, "PID"), 5, 1)).toBe("DOE^JR");
    expect(unescape(escape("a|b^c&d~e\\f", DEFAULT_DELIMITERS), DEFAULT_DELIMITERS)).toBe("a|b^c&d~e\\f");
    expect(() => parseMessage("PID|1")).toThrow(/MSH/);
  });

  it("frames and deframes across chunk boundaries", () => {
    const bytes = Buffer.concat([frame("MSH|^~\\&|A\nPID|1"), frame("MSH|^~\\&|B")]);
    const first = deframe(bytes.subarray(0, 10));
    expect(first.messages).toEqual([]);
    const rest = deframe(Buffer.concat([first.rest, bytes.subarray(10)]));
    expect(rest.messages).toEqual(["MSH|^~\\&|A\rPID|1\r", "MSH|^~\\&|B\r"]);
  });
});

describe("message handling", () => {
  it("admits, transfers, discharges, and merges patients", () => {
    const { store } = startService();
    const pv1 = "PV1|1|I|4W^401^A||||0000000002^EXAMPLE^LEE||||||||||||V900";
    const ack = receive(store, adt("A01", [pv1]));
    expect(msa(ack)).toMatchObject({ code: "AA", control: "CA01" });
    expect(parseMessage(ack).segments[0].fields[9]).toBe("ACK^A01^ACK");
    const patients = store.getData<Map<string, Patient>>("hl7v2.patients")!;
    const p = patients.get("syn-mrn-900")!;
    expect(p).toMatchObject({ family: "SYNTHETIC", given: "TAYLOR", birthDate: "19850505", sex: "F" });
    expect(p.visits[0]).toMatchObject({ visitNumber: "V900", location: "4W-401-A", status: "active" });

    expect(msa(receive(store, adt("A02", ["PV1|1|I|5E^501||||||||||||||||V900"])))).toMatchObject({ code: "AA" });
    expect(p.visits[0].location).toBe("5E-501");
    expect(msa(receive(store, adt("A03", ["PV1|1|I|||||||||||||||||V900"])))).toMatchObject({ code: "AA" });
    expect(p.visits[0].status).toBe("discharged");
    expect(msa(receive(store, adt("A03", ["PV1|1|I|||||||||||||||||V999"])))).toMatchObject({ code: "AE" });

    const merge = [
      "MSH|^~\\&|SYN_EHR|SYN_HOSP|EMUHEALTH|EMUHEALTH|20260101120000||ADT^A40^ADT_A39|M1|P|2.5.1",
      "PID|1||syn-patient-001^^^SYN^MR",
      "MRG|syn-mrn-900",
    ].join("\r");
    expect(msa(receive(store, merge))).toMatchObject({ code: "AA" });
    expect(patients.get("syn-mrn-900")!.mergedInto).toBe("syn-patient-001");
    expect(patients.get("syn-patient-001")!.visits).toHaveLength(1);
  });

  it("stores results and orders, and rejects malformed messages", () => {
    const { store } = startService();
    const oru = [
      "MSH|^~\\&|SYN_LAB|SYN_HOSP|EMUHEALTH|EMUHEALTH|20260101120000||ORU^R01^ORU_R01|R1|P|2.5.1",
      "PID|1||syn-patient-002^^^SYN^MR",
      "OBR|1|ORD1|LAB1|2345-7^Glucose^LN",
      "OBX|1|NM|2345-7^Glucose [Mass/volume] in Serum or Plasma^LN||101|mg/dL|70-99|H|||F|||20260101110000",
    ].join("\r");
    expect(msa(receive(store, oru)).code).toBe("AA");
    const p = store.getData<Map<string, Patient>>("hl7v2.patients")!.get("syn-patient-002")!;
    expect(p.observations[0]).toMatchObject({
      code: "2345-7",
      value: "101",
      units: "mg/dL",
      abnormalFlags: "H",
      order: "ORD1",
    });

    const orm = [
      "MSH|^~\\&|SYN_EHR|SYN_HOSP|EMUHEALTH|EMUHEALTH|20260101120000||ORM^O01^ORM_O01|O1|P|2.5.1",
      "PID|1||syn-patient-002^^^SYN^MR",
      "ORC|NW|ORD2",
      "OBR|1|ORD2||57021-8^CBC^LN",
    ].join("\r");
    expect(msa(receive(store, orm)).code).toBe("AA");
    expect(p.orders[0]).toMatchObject({ placerNumber: "ORD2", code: "57021-8", status: "IP" });
    expect(msa(receive(store, orm.replace("ORC|NW", "ORC|CA"))).code).toBe("AA");
    expect(p.orders[0].status).toBe("CA");

    expect(msa(receive(store, "garbage")).code).toBe("AR");
    expect(msa(receive(store, "MSH|^~\\&|A|B|C|D|20260101||ADT^A08||P|2.5")).code).toBe("AR");
    const ae = msa(receive(store, "MSH|^~\\&|A|B|C|D|20260101||ADT^A08|Z1|P|2.5\rEVN|A08"));
    expect(ae).toMatchObject({ code: "AE", text: "Required segment PID is missing" });
    expect(msa(receive(store, "MSH|^~\\&|A|B|C|D|20260101||SIU^S12|Z2|P|2.5")).code).toBe("AA");
  });

  it("rejects message types it does not apply in strict mode", () => {
    const { store } = startService();
    seedFromConfig(store, base, { strict: true });
    const ack = receive(store, "MSH|^~\\&|A|B|C|D|20260101||SIU^S12|Z3|P|2.5");
    expect(msa(ack)).toMatchObject({ code: "AR", text: "Message type SIU^S12 is not supported" });
    expect(segment(parseMessage(ack), "ERR")).toBeDefined();
    expect(ack).toContain("|200^^HL70357|");
    expect(msa(receive(store, adt("A01"))).code).toBe("AA");
    expect(() => seedFromConfig(store, base, { strict: "yes" as never })).toThrow("hl7v2.strict must be true or false");
  });
});

describe("HTTP API", () => {
  it("accepts messages over HTTP and lists messages and patients", async () => {
    const { req } = startService();
    const sample = await (await req("/samples/adt-a01?patient=syn-patient-003")).text();
    expect(sample.split("\r")[0]).toMatch(/^MSH\|\^~\\&\|SYNTHETIC_EHR/);
    const res = await req("/messages", { method: "POST", body: sample.replace(/\r/g, "\n") });
    expect(res.headers.get("content-type")).toContain("x-application/hl7-v2+er7");
    expect(msa(await res.text()).code).toBe("AA");
    const list = (await (await req("/messages?type=ADT")).json()) as any;
    expect(list.messages[0]).toMatchObject({ type: "ADT^A01", ackCode: "AA", direction: "inbound" });
    const p = (await (await req("/patients/syn-patient-003")).json()) as any;
    expect(p.visits).toHaveLength(1);
    for (const kind of ["adt-a03", "adt-a08", "oru-r01", "orm-o01"]) {
      const text = await (await req(`/samples/${kind}?patient=syn-patient-003`)).text();
      expect(msa(await (await req("/messages", { method: "POST", body: text })).text()).code, kind).toBe("AA");
    }
    expect((await req("/samples/nope")).status).toBe(404);
    expect((await req("/_inspector?tab=patients")).status).toBe(200);
  });
});

describe("MLLP", () => {
  it("acknowledges messages over TCP and sends to other receivers", async () => {
    const { store, req } = startService();
    const listener = await listen({ store, config: { mllp: { port: 0 } } });
    const port = Number(listener!.urls[0].split(":").pop());
    expect(((await (await req("/mllp")).json()) as any).port).toBe(port);
    try {
      const ack = await sendMllp("127.0.0.1", port, adt("A04", [], "TCP1"));
      expect(msa(ack)).toMatchObject({ code: "AA", control: "TCP1" });

      // A receiver under test that returns AE.
      const peer = createServer((socket) =>
        socket.on("data", () =>
          socket.write(frame("MSH|^~\\&|R|R|E|E|20260101||ACK^A01^ACK|K1|P|2.5.1\rMSA|AE|S1|Nope")),
        ),
      );
      await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r));
      const peerPort = (peer.address() as { port: number }).port;
      const res = await req("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: peerPort, message: adt("A01", [], "S1") }),
      });
      expect(await res.json()).toMatchObject({ ackCode: "AE" });
      peer.close();
      const out = (await (await req("/messages")).json()) as any;
      expect(out.messages[0]).toMatchObject({ direction: "outbound", ackCode: "AE", error: "Nope" });
    } finally {
      await listener!.close();
    }
    expect(await listen({ store, config: { mllp: false } })).toBeUndefined();
  });
});

describe("shared population", () => {
  it("holds the same people as the FHIR generator, and follows generator options", async () => {
    const { syntheticPeople } = await import("@emuhealth/fhir-core");
    const { store } = startService();
    const registry = store.getData<Map<string, Patient>>("hl7v2.patients")!;
    const people = syntheticPeople();
    expect([...registry.keys()]).toEqual(people.map((p) => p.id));
    const first = registry.get(people[0].id)!;
    expect(first.family).toBe(people[0].family.toUpperCase());
    expect(first.birthDate).toBe(people[0].birthDate.replace(/-/g, ""));
    expect(first.identifiers.map((i) => i.id)).toEqual([people[0].id, people[0].mrn]);

    seedFromConfig(store, base, { generate: { patients: 12, seed: 3 } });
    expect(registry.size).toBe(12);
    expect(registry.get("syn-patient-012")!.given).toBe(
      syntheticPeople({ patients: 12, seed: 3 })[11].given.toUpperCase(),
    );
  });
});

describe("inpatient-stay scenario", () => {
  it("adds the admission as a discharged visit", () => {
    const { store } = startService();
    seedFromConfig(store, base, { generate: { scenarios: ["inpatient-stay"] } });
    const visits = store.getData<Map<string, Patient>>("hl7v2.patients")!.get("syn-patient-002")!.visits;
    expect(visits).toEqual([
      expect.objectContaining({
        visitNumber: "V-002-INPT",
        patientClass: "I",
        status: "discharged",
        location: "3W ward, room 312",
      }),
    ]);
    expect(visits[0].admitted).toMatch(/^\d{14}$/);
  });
});

describe("MLLP failure testing", () => {
  it("drops connections without an ACK and delays ACKs", async () => {
    const { store } = startService();
    const dropping = await listen({ store, config: { mllp: { port: 0, dropRate: 1 } } });
    const slow = await listen({ store, config: { mllp: { port: 0, ackDelayMs: 300 } } });
    try {
      const dropPort = Number(dropping!.urls[0].split(":").pop());
      await expect(sendMllp("127.0.0.1", dropPort, adt("A04", [], "DROP1"), 1000)).rejects.toThrow();
      const messages = store.getData<unknown[]>("hl7v2.messages") ?? [];
      expect(messages).toHaveLength(0);

      const slowPort = Number(slow!.urls[0].split(":").pop());
      const started = Date.now();
      expect(msa(await sendMllp("127.0.0.1", slowPort, adt("A04", [], "SLOW1"))).code).toBe("AA");
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    } finally {
      await dropping!.close();
      await slow!.close();
    }
    expect(() => seedFromConfig(store, base, { mllp: { dropRate: 2 } })).toThrow(
      "hl7v2.mllp.dropRate must be from 0 to 1",
    );
  });
});
