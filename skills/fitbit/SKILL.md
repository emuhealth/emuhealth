---
name: fitbit
description: Emulated Fitbit Web API for local development and testing. Use when the user integrates Fitbit OAuth or reads steps, activity, heart rate (including intraday), sleep stages, or weight from Fitbit. Triggers include "Fitbit", "Fitbit API", "api.fitbit.com", "steps", "sleep stages", "heart rate zones", or any task needing a local Fitbit.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Fitbit Web API Emulator

Fitbit OAuth and data for synthetic users. Not affiliated with Google or Fitbit.

## Start

```bash
npx emuhealth --service fitbit
# http://localhost:4120 (for www.fitbit.com and api.fitbit.com)
```

## OAuth

`GET /oauth2/authorize?client_id=&redirect_uri=&response_type=code&scope=activity heartrate profile sleep weight` (consent page), then `POST /oauth2/token` with Basic auth: returns `access_token` (28800 s), `refresh_token`, `user_id` (`SYN00N`).

## Endpoints (Bearer token, user `-`)

- `/1/user/-/profile.json`
- `/1/user/-/activities/date/{date}.json`
- `/1/user/-/activities/steps/date/{date}/7d.json` (or `/{start}/{end}.json`; also distance, calories)
- `/1/user/-/activities/heart/date/{date}/1d.json`, intraday `/1d/1min.json`
- `/1.2/user/-/sleep/date/{date}.json`, `/1.2/user/-/sleep/date/{start}/{end}.json`
- `/1/user/-/body/log/weight/date/{date}.json`

Errors: `{"errors":[{"errorType":"invalid_token"|"insufficient_scope"|"validation"}],"success":false}`.

Docs: https://www.emuhealth.dev/docs/fitbit
