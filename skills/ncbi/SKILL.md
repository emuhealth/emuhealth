---
name: ncbi
description: Emulated NCBI E-utilities for PubMed and Gene, for local development and testing. Use when the user needs to search PubMed, fetch abstracts or citations, look up human genes, link genes to articles, or test code that calls eutils.ncbi.nlm.nih.gov. Triggers include "PubMed", "E-utilities", "eutils", "esearch", "efetch", "esummary", "NCBI Gene", "Entrez", or any task needing a local PubMed API.
allowed-tools: Bash(npx emuhealth:*), Bash(curl:*)
---

# NCBI E-utilities Emulator

E-utilities paths and parameters for `db=pubmed` (synthetic articles) and `db=gene` (ten real human genes).

## Start

```bash
npx emuhealth --service ncbi
# http://localhost:4105/entrez/eutils (use instead of https://eutils.ncbi.nlm.nih.gov/entrez/eutils)
```

## Utilities

GET or POST; add `retmode=json` for JSON (default XML).

- `esearch.fcgi?db=pubmed&term=...`: `esearchresult.idlist`, `count`; `retstart`, `retmax` (default 20); `usehistory=y` returns `webenv` and `querykey`.
- `esummary.fcgi?db=pubmed|gene&id=1,2` (or `WebEnv` and `query_key`): `result.uids` and one summary per id.
- `efetch.fcgi?db=pubmed&id=...`: `PubmedArticleSet` XML; `rettype=abstract&retmode=text` for text.
- `elink.fcgi?dbfrom=gene&db=pubmed&id=672`: `linksets[0].linksetdbs[0].links`.
- `einfo.fcgi`: database list.

Search terms: `AND`, `OR`, `NOT`, parentheses, `"phrases"`, tags `[ti]`, `[tiab]`, `[ab]`, `[au]`, `[1au]`, `[ta]`, `[mh]`, `[pt]`, `[gene]`, `2020:2023[dp]`; for genes `[sym]`, `[orgn]`, `[chr]`.

Synthetic PMIDs start at 99000001. Genes: BRCA1 672, TP53 7157, EGFR 1956, KRAS 3845, CFTR 1080, INS 3630, TNF 7124, CYP2D6 1565, MTHFR 4524, APOE 348.

## Seed config

```yaml
ncbi:
  generate: { articles: 80, seed: 1 } # or false
```

Docs: https://www.emuhealth.dev/docs/ncbi
