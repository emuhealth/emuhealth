---
name: withings
description: Emulated Withings API for local development and testing. Use when the user integrates Withings OAuth or reads weight, blood pressure, heart rate, SpO2, activity, or sleep from Withings devices, or handles Withings notify callbacks. Triggers include "Withings", "Withings API", "wbsapi", "getmeas", "Body+ scale", "BPM Connect", or any task needing a local Withings.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Withings API Emulator

Withings OAuth and action-based endpoints for synthetic users. Not affiliated with Withings.

## Start

```bash
npx emuhealth --service withings
# http://localhost:4122 (for account.withings.com and wbsapi.withings.net)
```

Every response is HTTP 200 with `status` (0 ok, 401 token or scope, 503 params, 294 no subscription) and `body`.

## OAuth

`GET /oauth2_user/authorize2?client_id=&redirect_uri=&response_type=code&scope=user.info,user.metrics,user.activity` (consent page), then `POST /v2/oauth2` with `action=requesttoken&grant_type=authorization_code&code=&client_id=&client_secret=&redirect_uri=`.

## Calls (Bearer token, form or query)

- `/measure action=getmeas startdate= enddate= meastypes=1,9,10,11,54`: weight (unit -3), BP, pulse, SpO2 (unit -1). Value = value * 10^unit.
- `/v2/measure action=getactivity startdateymd= enddateymd=`
- `/v2/sleep action=getsummary startdateymd= enddateymd=`
- `/v2/user action=getdevice`
- `/notify action=subscribe|list|revoke callbackurl= appli=`; `POST /emulator/notify userid=&appli=` fires callbacks.

Docs: https://www.emuhealth.dev/docs/withings
