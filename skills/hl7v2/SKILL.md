---
name: hl7v2
description: Emulated HL7 v2 interface over MLLP for local development and testing. Use when the user needs to send or receive HL7 v2 messages (ADT, ORU, ORM, OML), test an MLLP sender or receiver, check ACK handling, or replace an interface engine such as Mirth or Rhapsody in tests. Triggers include "HL7", "HL7v2", "MLLP", "ADT", "ORU", "ACK", "interface engine", or any task needing a local HL7 v2 endpoint.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# HL7 v2 (MLLP) Emulator

An MLLP listener that acknowledges every message and applies ADT, ORU, and order messages to a synthetic patient registry, plus an HTTP API.

## Start

```bash
npx emuhealth --service hl7v2
# MLLP: localhost:2575   HTTP API and inspector: http://localhost:4125
```

## Send a message

Over MLLP: frame with `0x0B` ... `0x1C 0x0D`, segments separated by `\r`. Over HTTP:

```bash
curl -s http://localhost:4125/samples/adt-a01 | curl -s --data-binary @- http://localhost:4125/messages | tr '\r' '\n'
```

Samples: `adt-a01`, `adt-a03`, `adt-a08`, `oru-r01`, `orm-o01` (`?patient=syn-patient-002`).

## ACKs

Original mode: `AA` accepted; `AE` could not apply (no PID, empty PID-3, no visit to discharge, unknown merge source); `AR` unparseable or missing MSH-9, MSH-10, MSH-12. MSA-2 echoes the control ID; errors add MSA-3 and an ERR segment.

## Effects

- ADT A01, A04, A05 create a patient and open a visit (PV1-19).
- A02, A06, A07 transfer the visit. A03 discharges it, A11 cancels the admit, A13 cancels the discharge. A08, A28, A31 update demographics. A40 merges MRG-1 into PID.
- ORU^R01 stores OBX results.
- ORM^O01 and OML^O21 store orders (ORC `CA` cancels them).
- Other message types are acknowledged and logged.

## Inspect and test receivers

- `GET /messages?type=ADT`, `GET /patients/{mrn}`.
- `POST /send` with `{"port": 6661, "message": "MSH|..."}` sends to your MLLP receiver and returns its ACK.
- `GET /mllp` returns the listener port.
- `/_inspector` shows messages and patients.

## Seed config

```yaml
hl7v2:
  mllp: { port: 2575, host: 127.0.0.1 } # or false
  generate: true # syn-patient-001 to 005
  patients:
    - { mrn: syn-mrn-100, family: SYNTHETIC, given: QUINN }
```

Docs: https://www.emuhealth.dev/docs/hl7v2

Example: https://github.com/emuhealth/emuhealth/tree/main/examples/hl7v2-to-fhir (MLLP bridge from this emulator's `/send` into the FHIR server).
