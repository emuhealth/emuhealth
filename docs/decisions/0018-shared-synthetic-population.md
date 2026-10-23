# 0018: Shared synthetic population

- Status: Accepted
- Date: 2026-10-24
- Refines: [0008](0008-fhir-core-design.md)

## Context

The FHIR, EHR, payer, and device emulators already draw their patients from fhir-core's seeded generator, so with default settings they describe the same people. Each one takes its own `generate` options, though, so a config that grows the population for one service splits the identities apart. The HL7 v2 registry had its own static list of five people, and Medidata Rave subjects had random demographics, so a flow that crosses an interface feed, an EHR, and a trial could not follow one person.

## Decision

- fhir-core exports `syntheticPeople(options)`: the Patients of the generator as plain people (FHIR id, MRN, name, birth date, gender, address, phone). Person n is the same whatever the total.
- A top-level `population` config key (`patients`, `seed`, `referenceDate`) applies to every patient-centric service. The CLI and `createEmulator` turn it into that service's `generate` options. A service's own `generate` wins, so one service can still be configured apart.
- The services it reaches: `fhir`, `epic`, `cerner`, `athena`, `bluebutton`, `redox`, `cdshooks`, `stedi`, `availity`, `dexcom`, `fitbit`, `oura`, `withings`, `terra`, `hl7v2`, and `rave`. The cloud FHIR stores (`healthlake`, `gcphealthcare`, `azurehealth`) preload per store and are not included.
- The HL7 v2 registry holds the population keyed by FHIR Patient id, with the FHIR MRN as a second PID-3 identifier.
- Rave subject n of EMU-101 (Prod) takes person n's birth date and sex. Other studies and environments keep generated demographics.

## Consequences

- One person can be followed across FHIR, an HL7 v2 feed, claims, devices, and a trial, which Phase 9 scenario packs build on.
- The HL7 v2 registry's default names changed from the old static list to the generator's names.
- New patient-centric emulators should read people from `syntheticPeople` and join the `population` list.
