# Security policy

emuhealth runs local emulators for development and testing. It is not a production system and must not hold real patient data.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (Security, then "Report a vulnerability"). Do not open a public issue for a security problem.

Include the version, the service, steps to reproduce, and the impact you see. Maintainers aim to acknowledge reports within a week and will credit reporters who want it.

## Scope

In scope:

- the published `emuhealth` npm package and the `ghcr.io/emuhealth/emuhealth` image;
- ways a malicious request or config could run code or read files on the host running an emulator;
- the GitHub Action and the release workflow.

Out of scope:

- emulated authentication being weak by design (for example accepting any client, or synthetic secrets in the docs);
- emulators exposed to untrusted networks: they listen on `127.0.0.1` by default and are not hardened for public access;
- issues in upstream emulate services, which should be reported to vercel-labs/emulate.

## Data

Never load real patient data (PHI) into emuhealth. If you find real patient data in this repository or its packages, report it privately as above so it can be removed.
