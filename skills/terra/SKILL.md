---
name: terra
description: Emulated Terra API (wearable aggregator) for local development and testing. Use when the user connects wearables through Terra widget sessions, reads Terra's normalized daily, sleep, activity, or body data, or verifies Terra webhook signatures. Triggers include "Terra", "tryterra", "Terra API", "generateWidgetSession", "terra-signature", "wearable aggregator", or any task needing a local Terra.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Terra API Emulator

Terra widget connections, normalized data, and signed webhooks with synthetic users. Not affiliated with Terra.

## Start

```bash
npx emuhealth --service terra
# http://localhost:4123, headers dev-id and x-api-key (any values unless terra.credentials is set)
```

## Connect

`POST /v2/auth/generateWidgetSession {"reference_id","providers":"FITBIT,OURA,DEXCOM","auth_success_redirect_url"}` returns `url`; open it, pick a provider and a synthetic account; redirect carries `user_id`, `resource`, `reference_id`; an `auth` webhook follows. Also `authenticateUser?resource=`, `userInfo`, `subscriptions`, `deauthenticateUser`.

## Data

`GET /v2/{daily|sleep|activity|body}?user_id=&start_date=&end_date=&to_webhook=false` returns `{status, type, user, data[]}`; without `to_webhook=false` it goes to the webhook. Body includes 5 minute glucose for DEXCOM and FREESTYLELIBRE.

## Webhooks

```yaml
terra:
  webhook: { url: http://localhost:3000/terra/webhook, secret: synthetic-signing-secret }
```

Header `terra-signature: t=<ts>,v1=<hex HMAC-SHA256("t.body")>`.

Docs: https://www.emuhealth.dev/docs/terra
