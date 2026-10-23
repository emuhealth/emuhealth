---
name: veeva
description: Emulated Veeva Vault REST API for local development and testing. Use when the user needs to authenticate to Vault, read or write Vault object records, manage documents, or run VQL queries, or test a clinical operations, regulatory, or quality integration without a real Vault. Triggers include "Veeva", "Vault", "VQL", "vobjects", "eTMF", "Vault API", or any task needing a local Vault.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# Veeva Vault Emulator

The Vault REST API under `/api/{version}` over synthetic products, studies, sites, countries, and trial documents.

## Start and sign in

```bash
npx emuhealth --service veeva
SESSION=$(curl -s -X POST http://localhost:4126/api/v24.3/auth \
  -d username=admin@synthetic-vault.example -d password=synthetic-password | jq -r .sessionId)
```

Send `Authorization: $SESSION` on every other call. Sessions idle out after 20 minutes. `DELETE /api/v24.3/session` ends one.

## Records

All routes are under `/api/v24.3`.

- `GET /vobjects/{object}?fields=id,name__v&limit=&offset=&sort=name__v desc` lists records.
- `GET /vobjects/{object}/{id}` returns one record.
- `POST /vobjects/{object}` creates records from a JSON array or CSV, up to 500. Add `?idParam=external_id__v` to upsert.
- `PUT` updates records by id and `DELETE` removes them.
- `GET /metadata/vobjects[/{object}]` describes objects.

The objects are `product__v`, `country__v`, `study__v` and `site__v`. Picklists are arrays (`["phase_2__v"]`).

## Documents

All routes are under `/api/v24.3`.

- `GET /objects/documents` (`search`, `versionscope=all`) and `GET /objects/documents/{id}`.
- `GET /objects/documents/{id}/file` downloads the file.
- `POST /objects/documents` takes multipart `name__v`, `type__v`, `lifecycle__v` and `file`.
- `PUT` and `DELETE /objects/documents/{id}`.

## VQL

```bash
curl -s -H "Authorization: $SESSION" http://localhost:4126/api/v24.3/query \
  --data-urlencode "q=SELECT id, name__v, study__vr.name__v FROM site__v WHERE site_status__v = 'active__v'"
```

The subset supports:

- the operators `=`, `!=`, `<`, `>`, `LIKE '%'`, `IN`, `CONTAINS`, `AND`, `OR`, `NOT` and parentheses;
- `ORDER BY`, `MAXROWS`, `PAGESIZE` and `PAGEOFFSET`;
- `__vr` relationships;
- `next_page` URLs;
- the `X-VaultAPI-DescribeQuery: true` header.

## Errors

The envelope is `{"responseStatus":"FAILURE","errors":[{"type":"INVALID_SESSION_ID","message":...}]}` with HTTP 200 (`MALFORMED_URL` returns 404). Other types: `USERNAME_OR_PASSWORD_INCORRECT`, `PARAMETER_REQUIRED`, `INVALID_DATA`, `ATTRIBUTE_NOT_SUPPORTED`, `OPERATION_NOT_ALLOWED`, `INCORRECT_QUERY_SYNTAX_ERROR`.

## Seed config

```yaml
veeva:
  users: [{ username: admin@synthetic-vault.example, password: synthetic-password }]
  generate: true # false starts empty
  records:
    product__v: [{ name__v: Examplor, generic_name__c: examplorumab }]
```

Not affiliated with Veeva Systems. Docs: https://www.emuhealth.dev/docs/veeva
