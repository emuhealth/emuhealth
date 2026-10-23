---
name: rxnav
description: Emulated NLM RxNav RxNorm REST API for local development and testing. Use when the user needs to look up RxNorm rxcuis, normalize drug names, find related ingredients or clinical drugs, or test code that calls rxnav.nlm.nih.gov. Triggers include "RxNav", "RxNorm", "rxcui", "drug name normalization", "approximateTerm", or any task needing a local RxNorm API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# RxNav (RxNorm API) Emulator

RxNav's `/REST` paths and JSON shapes over a small RxNorm subset plus concepts you add.

## Start

```bash
npx emuhealth --service rxnav
# http://localhost:4103/REST (use instead of https://rxnav.nlm.nih.gov/REST)
```

## Endpoints

Paths work with or without `.json`; responses are always JSON.

| Endpoint | Returns |
|----------|---------|
| `GET /REST/rxcui.json?name=lisinopril` | `{"idGroup":{"name":"lisinopril","rxnormId":["29046"]}}`, or `{"idGroup":{}}` |
| `GET /REST/drugs.json?name=metformin` | `drugGroup.conceptGroup` with the clinical drugs |
| `GET /REST/rxcui/314076/properties.json` | `properties` or `{}` |
| `GET /REST/rxcui/314076/related.json?tty=IN+SCD` | `relatedGroup.conceptGroup` |
| `GET /REST/rxcui/29046/allrelated.json` | `allRelatedGroup.conceptGroup` |
| `GET /REST/rxcui/:rxcui/ndcs.json` | empty `ndcList` (no NDCs bundled) |
| `GET /REST/approximateTerm.json?term=lisinoprel` | ranked `approximateGroup.candidate` |
| `GET /REST/spellingsuggestions.json?name=sertralin` | `suggestionGroup.suggestionList.suggestion` |

Built-in concepts: ingredients lisinopril 29046, metformin 6809, atorvastatin 83367, albuterol 435, omeprazole 7646, sertraline 36437, amoxicillin 723, penicillin G 7980, and their clinical drugs (for example 314076, 861007).

## Seed config

```yaml
rxnav:
  concepts:
    - { rxcui: "900001", name: examplemab, tty: IN }
    - { rxcui: "900002", name: examplemab 10 MG Injection, tty: SCD, ingredients: ["900001"] }
  defaults: false # optional: drop the built-in subset
```

Docs: https://www.emuhealth.dev/docs/rxnav
