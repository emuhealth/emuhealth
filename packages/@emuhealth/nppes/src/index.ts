import type { AppEnv, Context, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { generateProviders, type GenerateOptions, type Provider } from "./data.js";

export { generateProviders, syntheticNpi, type GenerateOptions, type Provider } from "./data.js";

/** NPPES NPI Registry API emulator: GET /api/?version=2.1 with the registry's search parameters, over synthetic providers. */
export interface NppesSeedConfig {
  port?: number;
  /** Generated providers; false starts empty. */
  generate?: GenerateOptions | false;
  /** Extra synthetic providers in the API's result shape (number and enumeration_type are required). */
  providers?: Provider[];
}

const DATA_KEY = "nppes.providers";
const SERVICE_LABEL = "NPPES";
const SEARCH_FIELDS = [
  "number",
  "taxonomy_description",
  "first_name",
  "last_name",
  "organization_name",
  "city",
  "postal_code",
];

function providers(store: Store): Provider[] {
  let list = store.getData<Provider[]>(DATA_KEY);
  if (!list) {
    list = [];
    store.setData(DATA_KEY, list);
  }
  return list;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: NppesSeedConfig): void {
  if (config.generate !== undefined) {
    if (config.generate !== false && (typeof config.generate !== "object" || config.generate === null))
      throw new Error("nppes.generate must be an object of generator options or false");
    store.setData(DATA_KEY, config.generate === false ? [] : generateProviders(config.generate));
  }
  if (config.providers === undefined) return;
  if (!Array.isArray(config.providers)) throw new Error("nppes.providers must be an array");
  const list = providers(store);
  for (const [i, provider] of config.providers.entries()) {
    if (typeof provider?.number !== "string" || !/^\d{10}$/.test(provider.number))
      throw new Error(`nppes.providers[${i}].number must be a 10 digit string`);
    if (provider.enumeration_type !== "NPI-1" && provider.enumeration_type !== "NPI-2")
      throw new Error(`nppes.providers[${i}].enumeration_type must be NPI-1 or NPI-2`);
    const existing = list.findIndex((p) => p.number === provider.number);
    if (existing >= 0) list[existing] = provider;
    else list.push(provider);
  }
}

type Errors = Array<{ description: string; field: string; number: string }>;

/** Names match whole values, case-insensitively, with an optional trailing * after at least two characters. */
function nameMatch(value: unknown, wanted: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.toUpperCase();
  const w = wanted.toUpperCase();
  return w.endsWith("*") ? v.startsWith(w.slice(0, -1)) : v === w;
}

function validate(p: URLSearchParams): Errors {
  const errors: Errors = [];
  if (p.get("version") !== "2.1") return [{ description: "Unsupported Version", field: "version", number: "17" }];
  if (!SEARCH_FIELDS.some((f) => p.get(f)))
    return [{ description: "No valid search criteria provided", field: "generic", number: "04" }];
  for (const field of ["first_name", "last_name", "organization_name", "city"]) {
    const value = p.get(field);
    if (value?.endsWith("*") && value.length < 3)
      errors.push({ description: "Field requires at least 2 characters before a wildcard", field, number: "07" });
  }
  const number = p.get("number");
  if (number && !/^\d{10}$/.test(number))
    errors.push({ description: "Field number requires number of length 10", field: "number", number: "10" });
  const type = p.get("enumeration_type");
  if (type && !["NPI-1", "NPI-2", "IND", "ORG"].includes(type.toUpperCase()))
    errors.push({
      description: "Field enumeration_type has an invalid value",
      field: "enumeration_type",
      number: "06",
    });
  return errors;
}

function matches(provider: Provider, p: URLSearchParams): boolean {
  const basic = (provider.basic ?? {}) as Record<string, unknown>;
  const addresses = (provider.addresses ?? []) as Array<Record<string, string>>;
  const taxonomies = (provider.taxonomies ?? []) as Array<Record<string, string>>;
  const number = p.get("number");
  if (number && provider.number !== number) return false;
  const type = p.get("enumeration_type")?.toUpperCase();
  if (type) {
    const wanted = type === "IND" ? "NPI-1" : type === "ORG" ? "NPI-2" : type;
    if (provider.enumeration_type !== wanted) return false;
  }
  const first = p.get("first_name");
  if (first && !nameMatch(basic.first_name, first)) return false;
  const last = p.get("last_name");
  if (last && !nameMatch(basic.last_name, last)) return false;
  const org = p.get("organization_name");
  if (org && !nameMatch(basic.organization_name, org)) return false;
  const taxonomy = p.get("taxonomy_description");
  if (taxonomy && !taxonomies.some((t) => t.desc?.toLowerCase().includes(taxonomy.toLowerCase().replace(/\*$/, ""))))
    return false;
  const purpose = p.get("address_purpose")?.toUpperCase();
  const relevant = addresses.filter((a) => !purpose || purpose === "PRIMARY" || a.address_purpose === purpose);
  const city = p.get("city");
  if (city && !relevant.some((a) => nameMatch(a.city, city))) return false;
  const state = p.get("state");
  if (state && !relevant.some((a) => a.state?.toUpperCase() === state.toUpperCase())) return false;
  const postal = p.get("postal_code");
  if (postal && !relevant.some((a) => a.postal_code?.startsWith(postal.replace(/\*$/, "")))) return false;
  const country = p.get("country_code");
  if (country && !relevant.some((a) => a.country_code?.toUpperCase() === country.toUpperCase())) return false;
  return true;
}

function inspector(store: Store): string {
  const rows = providers(store)
    .slice(0, 300)
    .map((p) => {
      const basic = (p.basic ?? {}) as Record<string, string>;
      const name =
        basic.organization_name ?? `${basic.first_name ?? ""} ${basic.last_name ?? ""} ${basic.credential ?? ""}`;
      const taxonomy = ((p.taxonomies ?? []) as Array<{ desc?: string }>)[0]?.desc ?? "";
      const city = ((p.addresses ?? []) as Array<{ city?: string; state?: string }>)[0];
      return `<tr><td><a href="${escapeAttr(`/api/?version=2.1&number=${p.number}`)}">${escapeHtml(String(p.number))}</a></td><td>${escapeHtml(String(p.enumeration_type))}</td><td>${escapeHtml(name.trim())}</td><td>${escapeHtml(taxonomy)}</td><td>${escapeHtml(city ? `${city.city}, ${city.state}` : "")}</td></tr>`;
    });
  const body = `<div class="inspector-section"><h2>Providers</h2><div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>NPI</th><th>type</th><th>name</th><th>taxonomy</th><th>location</th></tr></thead><tbody>${
    rows.length ? rows.join("") : '<tr><td colspan="5"><div class="inspector-empty">No providers</div></td></tr>'
  }</tbody></table></div></div>`;
  return renderInspectorPage(
    "NPPES inspector",
    [{ id: "providers", label: `Providers (${providers(store).length})`, href: "/_inspector" }],
    "providers",
    body,
    SERVICE_LABEL,
  );
}

export const nppesPlugin: ServicePlugin = {
  name: "nppes",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const search = (c: Context<AppEnv>) => {
      const p = new URL(c.req.url).searchParams;
      const errors = validate(p);
      if (errors.length) return c.json({ Errors: errors });
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 10) || 10, 1), 200);
      const skip = Number(p.get("skip") ?? 0) || 0;
      if (skip < 0 || skip > 1000)
        return c.json({ Errors: [{ description: "Field skip must be 1000 or less", field: "skip", number: "11" }] });
      const results = providers(store)
        .filter((provider) => matches(provider, p))
        .slice(skip, skip + limit);
      return c.json({ result_count: results.length, results });
    };
    app.get("/api/", search);
    app.get("/api", search);
    app.get("/_inspector", (c) => c.html(inspector(store)));
    app.get("/:rest{(?!_emulate).*}", (c) =>
      c.json({ Errors: [{ description: "Not found", field: "path", number: "404" }] }, 404),
    );
  },
  seed(store: Store): void {
    store.setData(DATA_KEY, generateProviders());
  },
};

export default nppesPlugin;
