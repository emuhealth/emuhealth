---
name: oura
description: Emulated Oura API v2 for local development and testing. Use when the user integrates Oura OAuth or reads daily sleep, readiness, activity, SpO2, sleep periods, or heart rate from the Oura Ring. Triggers include "Oura", "Oura Ring", "Oura API", "readiness score", "daily_sleep", "usercollection", or any task needing a local Oura API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Oura API v2 Emulator

Oura OAuth and `/v2/usercollection` documents for synthetic users. Not affiliated with Oura.

## Start

```bash
npx emuhealth --service oura
# http://localhost:4121 (for cloud.ouraring.com and api.ouraring.com)
```

## OAuth

`GET /oauth/authorize?client_id=&redirect_uri=&response_type=code` (consent page), `POST /oauth/token` returns `token_type: bearer`, `access_token` (86400 s), `refresh_token`.

## Endpoints (Bearer token)

- `/v2/usercollection/personal_info`
- `/v2/usercollection/{daily_sleep|daily_activity|daily_readiness|daily_spo2|sleep}?start_date=&end_date=` returns `{data, next_token}` (100 per page); `/{collection}/{id}`
- `/v2/usercollection/heartrate?start_datetime=&end_datetime=` (5 minute samples, max 30 days)
- `/v2/usercollection/workout`, `/session`, `/ring_configuration`

Errors: `{"detail": ...}` with 401, 403 (missing scope), 404, 400.

Docs: https://www.emuhealth.dev/docs/oura
