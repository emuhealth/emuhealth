import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { DEFAULT_CONCEPTS, type RxConcept } from "./concepts.js";

export { DEFAULT_CONCEPTS, type RxConcept } from "./concepts.js";

/**
 * NLM RxNav emulator: the RxNorm REST API paths and JSON shapes of rxnav.nlm.nih.gov/REST over a small RxNorm
 * subset, plus any concepts you add. Responses are JSON whether or not the path ends in .json.
 */
export interface RxNavSeedConfig {
  port?: number;
  /** Concepts to add (or replace, by rxcui). Clinical drugs list their ingredient rxcuis to relate them. */
  concepts?: RxConcept[];
  /** false starts without the built-in subset. Default true. */
  defaults?: boolean;
}

const DATA_KEY = "rxnav.concepts";
const SERVICE_LABEL = "RxNav";
const TTYS = ["IN", "PIN", "MIN", "SCDC", "SCDF", "SCDG", "SCD", "BN", "SBDC", "SBDF", "SBDG", "SBD", "GPCK", "BPCK"];

function concepts(store: Store): Map<string, RxConcept> {
  let map = store.getData<Map<string, RxConcept>>(DATA_KEY);
  if (!map) {
    map = new Map();
    store.setData(DATA_KEY, map);
  }
  return map;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: RxNavSeedConfig): void {
  if (config.defaults !== undefined && typeof config.defaults !== "boolean")
    throw new Error("rxnav.defaults must be true or false");
  if (config.defaults === false) concepts(store).clear();
  if (config.concepts === undefined) return;
  if (!Array.isArray(config.concepts)) throw new Error("rxnav.concepts must be an array");
  for (const [i, concept] of config.concepts.entries()) {
    if (!concept || typeof concept.rxcui !== "string" || !/^\d+$/.test(concept.rxcui))
      throw new Error(`rxnav.concepts[${i}].rxcui must be a string of digits`);
    if (typeof concept.name !== "string" || !concept.name) throw new Error(`rxnav.concepts[${i}].name is required`);
    if (typeof concept.tty !== "string" || !TTYS.includes(concept.tty))
      throw new Error(`rxnav.concepts[${i}].tty must be one of ${TTYS.join(", ")}`);
    concepts(store).set(concept.rxcui, { ...concept });
  }
}

const properties = (c: RxConcept) => ({
  rxcui: c.rxcui,
  name: c.name,
  synonym: c.synonym ?? "",
  tty: c.tty,
  language: "ENG",
  suppress: "N",
  umlscui: "",
});

/** Concepts grouped by term type, in RxNav's order, with every requested tty present even when empty. */
function conceptGroups(list: RxConcept[], ttys?: string[]) {
  const wanted = ttys ?? [...new Set(list.map((c) => c.tty))];
  return TTYS.filter((tty) => wanted.includes(tty)).map((tty) => {
    const members = list.filter((c) => c.tty === tty).map(properties);
    return members.length ? { tty, conceptProperties: members } : { tty };
  });
}

/** Ingredients of a drug, and drugs containing an ingredient. */
function related(all: Map<string, RxConcept>, concept: RxConcept): RxConcept[] {
  if (concept.ingredients?.length)
    return concept.ingredients.map((id) => all.get(id)).filter((c): c is RxConcept => Boolean(c));
  return [...all.values()].filter((c) => c.ingredients?.includes(concept.rxcui));
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** How close a term is to a concept name: whole-name distance, or the best word for single-word terms. */
function distance(term: string, name: string): number {
  const whole = levenshtein(term, name);
  if (term.includes(" ")) return whole;
  return Math.min(whole, ...name.split(/[\s/]+/).map((word) => levenshtein(term, word)));
}

function inspector(store: Store): string {
  const rows = [...concepts(store).values()]
    .sort((a, b) => TTYS.indexOf(a.tty) - TTYS.indexOf(b.tty) || a.name.localeCompare(b.name))
    .map((c) => {
      const href = `/REST/rxcui/${c.rxcui}/allrelated.json`;
      return `<tr><td><a href="${escapeAttr(href)}">${escapeHtml(c.rxcui)}</a></td><td>${escapeHtml(c.tty)}</td><td>${escapeHtml(c.name)}</td></tr>`;
    });
  const body = `<div class="inspector-section"><h2>RxNorm concepts</h2>
<div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>rxcui</th><th>tty</th><th>name</th></tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="3"><div class="inspector-empty">No concepts</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage(
    "RxNav inspector",
    [{ id: "concepts", label: "Concepts", href: "/_inspector" }],
    "concepts",
    body,
    SERVICE_LABEL,
  );
}

type AnyContext = Context<AppEnv>;

/** RxNav serves /REST/x and /REST/x.json; the emulator answers both with JSON. */
function route(app: Hono<AppEnv>, path: string, handler: (c: AnyContext) => Response) {
  app.get(`/REST${path}.json`, handler);
  app.get(`/REST${path}`, handler);
}

export const rxnavPlugin: ServicePlugin = {
  name: "rxnav",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const all = () => concepts(store);
    const query = (c: AnyContext, name: string) => c.req.query(name) ?? "";

    route(app, "/version", (c) => c.json({ version: "emuhealth RxNorm subset", apiVersion: "3.1.0" }));

    route(app, "/rxcui", (c) => {
      const name = normalize(query(c, "name"));
      const ids = [...all().values()].filter((x) => normalize(x.name) === name).map((x) => x.rxcui);
      return c.json({ idGroup: ids.length ? { name: query(c, "name"), rxnormId: ids } : {} });
    });

    route(app, "/drugs", (c) => {
      const name = normalize(query(c, "name"));
      if (!name) return c.json({ drugGroup: {} });
      const matched = [...all().values()].filter((x) => normalize(x.name) === name || normalize(x.name).includes(name));
      const ingredients = matched.filter((x) => x.tty === "IN");
      const drugs = new Map<string, RxConcept>();
      for (const x of matched) if (x.tty !== "IN") drugs.set(x.rxcui, x);
      for (const ingredient of ingredients) for (const drug of related(all(), ingredient)) drugs.set(drug.rxcui, drug);
      const list = [...drugs.values()];
      return c.json({
        drugGroup: list.length
          ? { name: query(c, "name"), conceptGroup: conceptGroups(list, ["BPCK", "GPCK", "SBD", "SCD"]) }
          : { name: query(c, "name") },
      });
    });

    route(app, "/rxcui/:rxcui/properties", (c) => {
      const concept = all().get(c.req.param("rxcui"));
      return c.json(concept ? { properties: properties(concept) } : {});
    });

    route(app, "/rxcui/:rxcui/related", (c) => {
      const concept = all().get(c.req.param("rxcui"));
      const ttys = query(c, "tty")
        .split(/[\s+]+/)
        .filter(Boolean);
      if (!concept) return c.json({ relatedGroup: { rxcui: c.req.param("rxcui"), termType: ttys } });
      return c.json({
        relatedGroup: {
          rxcui: concept.rxcui,
          termType: ttys,
          conceptGroup: conceptGroups(related(all(), concept), ttys.length ? ttys : undefined),
        },
      });
    });

    route(app, "/rxcui/:rxcui/allrelated", (c) => {
      const concept = all().get(c.req.param("rxcui"));
      if (!concept) return c.json({ allRelatedGroup: { rxcui: c.req.param("rxcui") } });
      return c.json({
        allRelatedGroup: { rxcui: concept.rxcui, conceptGroup: conceptGroups(related(all(), concept), TTYS) },
      });
    });

    // No NDC data is bundled: product codes belong to real labelers.
    route(app, "/rxcui/:rxcui/ndcs", (c) => c.json({ ndcGroup: { rxcui: c.req.param("rxcui"), ndcList: {} } }));

    route(app, "/approximateTerm", (c) => {
      const term = normalize(query(c, "term"));
      const max = Math.min(Math.max(Number(query(c, "maxEntries")) || 20, 1), 100);
      if (!term) return c.json({ approximateGroup: { inputTerm: null } });
      const scored = [...all().values()]
        .map((x, i) => ({ concept: x, d: distance(term, normalize(x.name)), i }))
        .filter((s) => s.d <= Math.max(2, Math.floor(term.length / 3)))
        .sort((a, b) => a.d - b.d || a.concept.name.length - b.concept.name.length);
      const ranks = [...new Set(scored.map((s) => s.d))];
      return c.json({
        approximateGroup: {
          inputTerm: null,
          candidate: scored.slice(0, max).map((s) => ({
            rxcui: s.concept.rxcui,
            rxaui: String(9_000_000 + (Number(s.concept.rxcui) % 1_000_000)),
            score: (10 - s.d).toFixed(6),
            rank: String(ranks.indexOf(s.d) + 1),
            name: s.concept.name,
            source: "RXNORM",
          })),
        },
      });
    });

    route(app, "/spellingsuggestions", (c) => {
      const name = normalize(query(c, "name"));
      const words = new Set([...all().values()].filter((x) => x.tty === "IN").map((x) => normalize(x.name)));
      const suggestions = [...words]
        .map((w) => ({ w, d: levenshtein(name, w) }))
        .filter((s) => name && s.d > 0 && s.d <= Math.max(2, Math.floor(name.length / 4)))
        .sort((a, b) => a.d - b.d)
        .map((s) => s.w);
      return c.json({
        suggestionGroup: { name: null, suggestionList: suggestions.length ? { suggestion: suggestions } : {} },
      });
    });

    route(app, "/displaynames", (c) =>
      c.json({ displayTermsList: { term: [...all().values()].map((x) => x.name).sort() } }),
    );

    app.get("/_inspector", (c) => c.html(inspector(store)));
    app.get("/:rest{(?!_emulate).*}", (c) => c.json({}, 404));
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, new Map(DEFAULT_CONCEPTS.map((c) => [c.rxcui, { ...c }])));
  },
};

export default rxnavPlugin;
