---
name: xds
description: Emulated IHE document sharing (XDS.b registry and repository, XCA responding gateway) over SOAP 1.2 with MTOM, for local development and testing. Use when the user builds or tests document exchange with an HIE or EHR, ITI-41, ITI-18, ITI-43, ITI-38, or ITI-39 transactions, or needs a local XDS registry. Triggers include "XDS", "XDS.b", "XCA", "IHE", "ITI-41", "ITI-18", "ITI-43", "document registry", "document repository", "ebRIM", "MTOM", or any task needing a local IHE document sharing endpoint.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# IHE XDS and XCA Emulator

SOAP 1.2 (WS-Addressing, plain or MTOM) on `http://localhost:4130`.

```bash
npx emuhealth --service xds
curl http://localhost:4130/documents
```

- `/xds/repository`: ITI-41 provide and register (inline base64 or `xop:Include`), ITI-43 retrieve.
- `/xds/registry`: ITI-18 stored queries FindDocuments (`$XDSDocumentEntryPatientId`, `$XDSDocumentEntryStatus` required), GetDocuments, GetSubmissionSets; ITI-42 register.
- `/xca/query`, `/xca/retrieve`: ITI-38, ITI-39 with `home` and `HomeCommunityId`.
- Patient ids: population MRNs, `SYN-000001^^^&2.25.211144934573491648823315826212385512893&ISO`. Repository `2.25.106212425219263453271339394582217123742`, home `urn:oid:2.25.338474659226574913810834289214564431301`.
- Errors: XDSUnknownPatientId, XDSMissingDocument, XDSDuplicateUniqueIdInRegistry, XDSNonIdenticalHash, XDSStoredQueryParamNumber, XDSUnknownStoredQuery, XDSDocumentUniqueIdError, XDSUnknownCommunity. Bad actions give a SOAP Fault.
- Seed: `xds.generate` (population options or false), `xds.patientIds`.

Docs: https://www.emuhealth.dev/docs/xds
