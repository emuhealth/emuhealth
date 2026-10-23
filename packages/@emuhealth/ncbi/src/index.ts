import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { GENES, generateArticles, type Article, type Gene, type GenerateOptions } from "./data.js";

export { GENES, generateArticles, type Article, type Gene, type GenerateOptions } from "./data.js";

/**
 * NCBI E-utilities emulator for PubMed and Gene: einfo, esearch (with history), esummary, efetch, and elink at
 * /entrez/eutils/*.fcgi, over synthetic PubMed articles and a small set of real genes.
 */
export interface NcbiSeedConfig {
  port?: number;
  /** Synthetic PubMed articles; false starts without them. */
  generate?: GenerateOptions | false;
}

const DATA_KEY = "ncbi.data";
const PATH = "/entrez/eutils";
const SERVICE_LABEL = "NCBI";
const DATABASES = ["pubmed", "gene"] as const;
type Db = (typeof DATABASES)[number];

interface Data {
  articles: Article[];
  history: Map<string, string[]>;
}

function data(store: Store): Data {
  let d = store.getData<Data>(DATA_KEY);
  if (!d) {
    d = { articles: [], history: new Map() };
    store.setData(DATA_KEY, d);
  }
  return d;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: NcbiSeedConfig): void {
  if (config.generate === undefined) return;
  if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
    throw new Error("ncbi.generate must be an object of generator options or false");
  data(store).articles = config.generate === false ? [] : generateArticles(config.generate);
}

// Entrez search terms: words and "phrases" with optional [field] tags, AND, OR, NOT, and parentheses.

type Node =
  | { kind: "and" | "or"; children: Node[] }
  | { kind: "not"; left: Node; right: Node }
  | { kind: "term"; text: string; field: string };

function tokenize(term: string): string[] {
  const tokens: string[] = [];
  const re = /\s*("[^"]*"(?:\[[^\]]*\])?|\(|\)|[^\s()"]+(?:\[[^\]]*\])?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(term))) if (m[1]) tokens.push(m[1]);
  return tokens;
}

function parseTerm(term: string): Node | undefined {
  const tokens = tokenize(term);
  let pos = 0;
  const primary = (): Node | undefined => {
    const t = tokens[pos++];
    if (t === undefined || t === ")") return undefined;
    if (t === "(") {
      const node = or();
      if (tokens[pos] === ")") pos++;
      return node;
    }
    const tagged = /^(.*?)(?:\[([^\]]*)\])?$/.exec(t)!;
    return { kind: "term", text: tagged[1].replace(/^"|"$/g, ""), field: (tagged[2] ?? "").toLowerCase() };
  };
  const and = (): Node | undefined => {
    let left = primary();
    while (left && pos < tokens.length && tokens[pos] !== ")" && tokens[pos] !== "OR") {
      if (tokens[pos] === "NOT") {
        pos++;
        const right = primary();
        if (right) left = { kind: "not", left, right };
        continue;
      }
      if (tokens[pos] === "AND") pos++;
      const right = primary();
      if (right)
        left =
          left.kind === "and"
            ? { kind: "and", children: [...left.children, right] }
            : { kind: "and", children: [left, right] };
    }
    return left;
  };
  const or = (): Node | undefined => {
    let left = and();
    while (left && tokens[pos] === "OR") {
      pos++;
      const right = and();
      if (right)
        left =
          left.kind === "or"
            ? { kind: "or", children: [...left.children, right] }
            : { kind: "or", children: [left, right] };
    }
    return left;
  };
  return or();
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function containsPhrase(texts: string[], phrase: string): boolean {
  const wanted = words(phrase);
  if (wanted.length === 0) return false;
  const prefix = phrase.endsWith("*");
  return texts.some((text) => {
    const have = words(text);
    if (prefix && wanted.length === 1) return have.some((w) => w.startsWith(wanted[0]));
    for (let i = 0; i + wanted.length <= have.length; i++) if (wanted.every((w, j) => have[i + j] === w)) return true;
    return false;
  });
}

/** Text per Entrez field tag for an article. */
function articleFields(a: Article, field: string): string[] {
  switch (field) {
    case "ti":
    case "title":
      return [a.title];
    case "tiab":
      return [a.title, a.abstract];
    case "ab":
      return [a.abstract];
    case "au":
    case "author":
      return a.authors;
    case "1au":
      return a.authors.slice(0, 1);
    case "ta":
    case "journal":
    case "jour":
      return [a.journal.title, a.journal.iso];
    case "mh":
    case "mesh":
    case "majr":
    case "kw":
      return a.keywords;
    case "pt":
      return a.pubtype;
    case "uid":
    case "pmid":
      return [a.uid];
    case "gene":
      return a.genes.map((id) => GENES.find((g) => g.uid === id)!.name);
    default:
      return [a.title, a.abstract, ...a.authors, a.journal.title, ...a.keywords, ...a.pubtype, a.uid, a.doi];
  }
}

function geneFields(g: Gene, field: string): string[] {
  switch (field) {
    case "sym":
    case "gene":
    case "preferred symbol":
      return [g.name];
    case "orgn":
    case "organism":
      return ["Homo sapiens", "human"];
    case "chr":
      return [g.chromosome];
    case "uid":
      return [g.uid];
    default:
      return [g.name, g.description, g.otheraliases, g.summary, g.maplocation, g.uid, "Homo sapiens", "human"];
  }
}

function matchesNode(node: Node, fields: (field: string) => string[], year?: number): boolean {
  switch (node.kind) {
    case "and":
      return node.children.every((c) => matchesNode(c, fields, year));
    case "or":
      return node.children.some((c) => matchesNode(c, fields, year));
    case "not":
      return matchesNode(node.left, fields, year) && !matchesNode(node.right, fields, year);
    case "term": {
      if (["dp", "pdat", "publication date"].includes(node.field)) {
        if (year === undefined) return false;
        const [from, to = from] = node.text.split(":").map((v) => Number(v.slice(0, 4)));
        return year >= from && year <= to;
      }
      return containsPhrase(fields(node.field), node.text);
    }
  }
}

function searchIds(store: Store, db: Db, term: string): string[] {
  const node = parseTerm(term);
  if (db === "gene") {
    if (!node) return [];
    return GENES.filter((g) => matchesNode(node, (f) => geneFields(g, f))).map((g) => g.uid);
  }
  const articles = data(store).articles;
  if (!node) return [];
  return articles
    .filter((a) => matchesNode(node, (f) => articleFields(a, f), a.year))
    .sort((a, b) => b.year - a.year || b.month - a.month || Number(b.uid) - Number(a.uid))
    .map((a) => a.uid);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function articleSummary(a: Article) {
  return {
    uid: a.uid,
    pubdate: `${a.year} ${MONTHS[a.month - 1]}`,
    epubdate: "",
    source: a.journal.iso,
    authors: a.authors.map((name) => ({ name, authtype: "Author", clusterid: "" })),
    lastauthor: a.authors[a.authors.length - 1],
    title: a.title,
    sorttitle: a.title.toLowerCase(),
    volume: a.volume,
    issue: a.issue,
    pages: a.pages,
    lang: ["eng"],
    nlmuniqueid: "",
    issn: a.journal.issn,
    essn: a.journal.essn,
    pubtype: a.pubtype,
    recordstatus: "PubMed - synthetic record",
    pubstatus: "4",
    articleids: [
      { idtype: "pubmed", idtypen: 1, value: a.uid },
      { idtype: "doi", idtypen: 3, value: a.doi },
    ],
    fulljournalname: a.journal.title,
    elocationid: `doi: ${a.doi}`,
    sortpubdate: `${a.year}/${String(a.month).padStart(2, "0")}/01 00:00`,
    sortfirstauthor: a.authors[0],
  };
}

function geneSummary(g: Gene) {
  return {
    uid: g.uid,
    name: g.name,
    description: g.description,
    status: "",
    currentid: "",
    chromosome: g.chromosome,
    geneticsource: "genomic",
    maplocation: g.maplocation,
    otheraliases: g.otheraliases,
    otherdesignations: "",
    nomenclaturesymbol: g.name,
    nomenclaturename: g.description,
    nomenclaturestatus: "Official",
    mim: g.mim,
    genomicinfo: g.genomicinfo,
    summary: g.summary,
    organism: { scientificname: "Homo sapiens", commonname: "human", taxid: 9606 },
  };
}

// XML output, for clients that do not ask for JSON.

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toXml(name: string, value: unknown): string {
  if (Array.isArray(value)) return `<${name}>${value.map((v) => toXml("Item", v)).join("")}</${name}>`;
  if (value && typeof value === "object")
    return `<${name}>${Object.entries(value)
      .map(([k, v]) => toXml(k, v))
      .join("")}</${name}>`;
  return `<${name}>${xml(String(value ?? ""))}</${name}>`;
}

function pubmedXml(articles: Article[]): string {
  const body = articles
    .map(
      (a) =>
        `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${a.uid}</PMID><Article PubModel="Print"><Journal><ISSN IssnType="Print">${a.journal.issn}</ISSN><JournalIssue CitedMedium="Print"><Volume>${a.volume}</Volume><Issue>${a.issue}</Issue><PubDate><Year>${a.year}</Year><Month>${MONTHS[a.month - 1]}</Month></PubDate></JournalIssue><Title>${xml(a.journal.title)}</Title><ISOAbbreviation>${xml(a.journal.iso)}</ISOAbbreviation></Journal><ArticleTitle>${xml(a.title)}</ArticleTitle><Pagination><MedlinePgn>${a.pages}</MedlinePgn></Pagination><Abstract><AbstractText>${xml(a.abstract)}</AbstractText></Abstract><AuthorList CompleteYN="Y">${a.authors
          .map((name) => {
            const [last, initials] = name.split(" ");
            return `<Author ValidYN="Y"><LastName>${xml(last)}</LastName><Initials>${xml(initials)}</Initials></Author>`;
          })
          .join("")}</AuthorList><Language>eng</Language><PublicationTypeList>${a.pubtype
          .map((t) => `<PublicationType>${xml(t)}</PublicationType>`)
          .join("")}</PublicationTypeList></Article><KeywordList Owner="NOTNLM">${a.keywords
          .map((k) => `<Keyword MajorTopicYN="N">${xml(k)}</Keyword>`)
          .join(
            "",
          )}</KeywordList></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${a.uid}</ArticleId><ArticleId IdType="doi">${xml(a.doi)}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`,
    )
    .join("");
  return `<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet>${body}</PubmedArticleSet>`;
}

function abstractText(articles: Article[]): string {
  return articles
    .map(
      (a, i) =>
        `${i + 1}. ${a.journal.iso}. ${a.year} ${MONTHS[a.month - 1]};${a.volume}(${a.issue}):${a.pages}. doi: ${a.doi}\n\n${a.title}\n\n${a.authors.join(", ")}.\n\n${a.abstract}\n\nPMID: ${a.uid}`,
    )
    .join("\n\n\n");
}

type AnyContext = Context<AppEnv>;

function params(c: AnyContext, body?: URLSearchParams): URLSearchParams {
  const query = new URL(c.req.url).searchParams;
  if (body) for (const [k, v] of body) query.append(k, v);
  return query;
}

async function readParams(c: AnyContext): Promise<URLSearchParams> {
  if (c.req.method === "POST") return params(c, new URLSearchParams(await c.req.text()));
  return params(c);
}

function inspector(store: Store, tab: string): string {
  const tabs = [
    { id: "pubmed", label: `PubMed (${data(store).articles.length})`, href: "/_inspector?tab=pubmed" },
    { id: "gene", label: `Gene (${GENES.length})`, href: "/_inspector?tab=gene" },
  ];
  const active = tab === "gene" ? "gene" : "pubmed";
  const rows =
    active === "gene"
      ? GENES.map(
          (g) =>
            `<tr><td><a href="${escapeAttr(`${PATH}/esummary.fcgi?db=gene&id=${g.uid}&retmode=json`)}">${g.uid}</a></td><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.description)}</td><td>${escapeHtml(g.maplocation)}</td></tr>`,
        )
      : data(store)
          .articles.slice(0, 200)
          .map(
            (a) =>
              `<tr><td><a href="${escapeAttr(`${PATH}/efetch.fcgi?db=pubmed&id=${a.uid}&rettype=abstract&retmode=text`)}">${a.uid}</a></td><td>${escapeHtml(a.title)}</td><td>${escapeHtml(a.journal.iso)}</td><td>${a.year}</td></tr>`,
          );
  const head = active === "gene" ? ["Gene ID", "symbol", "name", "location"] : ["PMID", "title", "journal", "year"];
  const body = `<div class="inspector-section"><h2>${active === "gene" ? "Gene" : "PubMed"}</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr>${head
    .map((h) => `<th>${h}</th>`)
    .join("")}</tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="4"><div class="inspector-empty">No records</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage("NCBI inspector", tabs, active, body, SERVICE_LABEL);
}

export const ncbiPlugin: ServicePlugin = {
  name: "ncbi",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    let historyCount = 0;
    const header = (type: string) => ({ type, version: "0.3" });
    const dbOf = (p: URLSearchParams): Db | undefined => {
      const db = (p.get("db") ?? "pubmed").toLowerCase();
      return (DATABASES as readonly string[]).includes(db) ? (db as Db) : undefined;
    };
    /** ids from id= or from a WebEnv and query_key saved by esearch usehistory=y. */
    const idsOf = (p: URLSearchParams): string[] => {
      const webenv = p.get("WebEnv") ?? p.get("webenv");
      if (webenv) return data(store).history.get(`${webenv}#${p.get("query_key") ?? "1"}`) ?? [];
      return (p.get("id") ?? "").split(/[,\s]+/).filter(Boolean);
    };
    const page = (ids: string[], p: URLSearchParams, fallback: number) => {
      const start = Math.max(0, Number(p.get("retstart") ?? 0) || 0);
      const max = Math.min(Math.max(0, Number(p.get("retmax") ?? fallback) || 0), 10000);
      return ids.slice(start, start + max);
    };

    const einfo = async (c: AnyContext) => {
      const p = await readParams(c);
      const json = p.get("retmode") === "json";
      const db = p.get("db");
      const result = db
        ? {
            dbinfo: [
              {
                dbname: db,
                menuname: db === "gene" ? "Gene" : "PubMed",
                description:
                  db === "gene" ? "Gene database (emuhealth subset)" : "PubMed bibliographic record (synthetic)",
                count: String(db === "gene" ? GENES.length : data(store).articles.length),
                lastupdate: "2026/01/01 00:00",
              },
            ],
          }
        : { dblist: [...DATABASES] };
      if (json) return c.json({ header: header("einfo"), einforesult: result });
      return c.body(`<?xml version="1.0" ?>\n${toXml("eInfoResult", result)}`, 200, { "Content-Type": "text/xml" });
    };

    const esearch = async (c: AnyContext) => {
      const p = await readParams(c);
      const db = dbOf(p);
      const json = p.get("retmode") === "json";
      if (!db) {
        const error = `Invalid db name specified: ${p.get("db")}`;
        return json
          ? c.json({ header: header("esearch"), esearchresult: { ERROR: error } })
          : c.body(`<?xml version="1.0" ?>\n<eSearchResult><ERROR>${xml(error)}</ERROR></eSearchResult>`, 200, {
              "Content-Type": "text/xml",
            });
      }
      const term = p.get("term") ?? "";
      let ids = searchIds(store, db, term);
      if (p.get("sort") === "first_author" && db === "pubmed") {
        const byId = new Map(data(store).articles.map((a) => [a.uid, a]));
        ids = [...ids].sort((a, b) => byId.get(a)!.authors[0].localeCompare(byId.get(b)!.authors[0]));
      }
      const shown = page(ids, p, 20);
      const history =
        p.get("usehistory") === "y" ? { webenv: `MCID_emuhealth_${++historyCount}`, querykey: "1" } : undefined;
      if (history) data(store).history.set(`${history.webenv}#1`, ids);
      const result = {
        count: String(ids.length),
        retmax: String(shown.length),
        retstart: String(Math.max(0, Number(p.get("retstart") ?? 0) || 0)),
        ...(history ? { querykey: history.querykey, webenv: history.webenv } : {}),
        idlist: shown,
        translationset: [],
        querytranslation: term,
        ...(ids.length === 0
          ? { warninglist: { phrasesignored: [], quotedphrasesnotfound: [], outputmessages: ["No items found."] } }
          : {}),
      };
      if (json) return c.json({ header: header("esearch"), esearchresult: result });
      const idXml = shown.map((id) => `<Id>${id}</Id>`).join("");
      return c.body(
        `<?xml version="1.0" ?>\n<eSearchResult><Count>${result.count}</Count><RetMax>${result.retmax}</RetMax><RetStart>${result.retstart}</RetStart>${
          history ? `<QueryKey>1</QueryKey><WebEnv>${history.webenv}</WebEnv>` : ""
        }<IdList>${idXml}</IdList><TranslationSet/><QueryTranslation>${xml(term)}</QueryTranslation></eSearchResult>`,
        200,
        { "Content-Type": "text/xml" },
      );
    };

    const esummary = async (c: AnyContext) => {
      const p = await readParams(c);
      const db = dbOf(p);
      const json = p.get("retmode") === "json";
      if (!db) return c.json({ header: header("esummary"), error: `Invalid db name specified: ${p.get("db")}` });
      const ids = page(idsOf(p), p, 10000);
      const articles = new Map(data(store).articles.map((a) => [a.uid, a]));
      const result: Record<string, unknown> = { uids: [] as string[] };
      for (const id of ids) {
        const summary =
          db === "gene"
            ? GENES.find((g) => g.uid === id) && geneSummary(GENES.find((g) => g.uid === id)!)
            : articles.get(id) && articleSummary(articles.get(id)!);
        if (summary) {
          (result.uids as string[]).push(id);
          result[id] = summary;
        } else result[id] = { uid: id, error: "cannot get document summary" };
      }
      if (json) return c.json({ header: header("esummary"), result });
      const docs = (result.uids as string[])
        .map((id) => toXml("DocumentSummary", result[id]).replace("<DocumentSummary>", `<DocumentSummary uid="${id}">`))
        .join("");
      return c.body(
        `<?xml version="1.0" ?>\n<eSummaryResult><DocumentSummarySet status="OK">${docs}</DocumentSummarySet></eSummaryResult>`,
        200,
        { "Content-Type": "text/xml" },
      );
    };

    const efetch = async (c: AnyContext) => {
      const p = await readParams(c);
      const db = dbOf(p);
      if (!db) return c.body(`Invalid db name specified: ${p.get("db")}`, 400, { "Content-Type": "text/plain" });
      const ids = page(idsOf(p), p, 10000);
      if (db === "gene") {
        const genes = ids.map((id) => GENES.find((g) => g.uid === id)).filter((g): g is Gene => Boolean(g));
        return c.body(
          genes
            .map(
              (g, i) =>
                `${i + 1}. ${g.name}\nOfficial Symbol: ${g.name} and Name: ${g.description} [Homo sapiens (human)]\nChromosome: ${g.chromosome}; Location: ${g.maplocation}\nID: ${g.uid}`,
            )
            .join("\n\n"),
          200,
          { "Content-Type": "text/plain" },
        );
      }
      const byId = new Map(data(store).articles.map((a) => [a.uid, a]));
      const articles = ids.map((id) => byId.get(id)).filter((a): a is Article => Boolean(a));
      if (p.get("retmode") === "text" || p.get("rettype") === "abstract")
        return c.body(abstractText(articles), 200, { "Content-Type": "text/plain" });
      return c.body(pubmedXml(articles), 200, { "Content-Type": "text/xml" });
    };

    const elink = async (c: AnyContext) => {
      const p = await readParams(c);
      const from = (p.get("dbfrom") ?? "").toLowerCase();
      const to = (p.get("db") ?? "").toLowerCase();
      const ids = idsOf(p);
      const articles = data(store).articles;
      const links = (id: string): string[] => {
        if (from === "gene" && to === "pubmed") return articles.filter((a) => a.genes.includes(id)).map((a) => a.uid);
        if (from === "pubmed" && to === "gene") return articles.find((a) => a.uid === id)?.genes ?? [];
        return [];
      };
      const all = [...new Set(ids.flatMap(links))];
      return c.json({
        header: header("elink"),
        linksets: [
          {
            dbfrom: from,
            ids,
            ...(all.length ? { linksetdbs: [{ dbto: to, linkname: `${from}_${to}`, links: all }] } : {}),
          },
        ],
      });
    };

    for (const [name, handler] of Object.entries({ einfo, esearch, esummary, efetch, elink })) {
      app.get(`${PATH}/${name}.fcgi`, handler);
      app.post(`${PATH}/${name}.fcgi`, handler);
    }
    app.get("/_inspector", (c) => c.html(inspector(store, c.req.query("tab") ?? "pubmed")));
    app.get("/:rest{(?!_emulate).*}", (c) => c.body("Not found", 404, { "Content-Type": "text/plain" }));
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, { articles: generateArticles(), history: new Map() });
  },
};

export default ncbiPlugin;
