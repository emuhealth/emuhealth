# Contract drift check

`check.mjs` compares upstream releases with what emuhealth emulates, pins, or has last reviewed:

- the HL7 FHIR Validator and the Inferno US Core kit the CI gates use;
- the US Core, SMART App Launch, and FHIR R5 core packages;
- the Vault API version Veeva's VAPIL client asks for, which the Veeva emulator must list at `GET /api`;
- VAPIL and the Python clients the contract tests pin.

The weekly `Contract drift` workflow fails when something was released since the versions in `baseline.json`, or when the Veeva emulator does not list the Vault API version current clients use. Review the change (update an emulator, a pin, or the docs as needed), then record it:

```bash
node tests/drift/check.mjs --update
```
