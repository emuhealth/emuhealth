// Synthetic NPPES providers. NPIs carry a valid check digit but start with 0, which no real NPI does, names come from
// the emuhealth name lists, phones use the fictional 555-01xx range, and taxonomy codes are SYNTH placeholders: the
// NUCC Health Care Provider Taxonomy is licensed for use in the United States only, so emuhealth does not bundle it.

export type Provider = Record<string, unknown>;

export interface GenerateOptions {
  /** Individual providers (NPI-1), 0 to 2000. Default 40. */
  individuals?: number;
  /** Organizations (NPI-2), 0 to 1000. Default 15. */
  organizations?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
}

const FIRST = ["OLIVIA", "EMMA", "AVA", "SOPHIA", "MIA", "GRACE", "LIAM", "NOAH", "ELIJAH", "JAMES", "LUCAS", "MATEO"];
const LAST = [
  "GARCIA",
  "NGUYEN",
  "PATEL",
  "JOHNSON",
  "KIM",
  "OKAFOR",
  "ROSSI",
  "COHEN",
  "SILVA",
  "MURPHY",
  "HADDAD",
  "NOVAK",
];
const PLACES = [
  { city: "SPRINGFIELD", state: "IL", zip: "62701" },
  { city: "RIVERTON", state: "WY", zip: "82501" },
  { city: "FAIRVIEW", state: "OR", zip: "97024" },
  { city: "LAKESIDE", state: "CA", zip: "92040" },
  { city: "GREENVILLE", state: "SC", zip: "29601" },
];
const STREETS = ["MAPLE", "OAK", "CEDAR", "WILLOW", "BIRCH", "ELM"];
const INDIVIDUAL_TYPES = [
  { code: "SYNTH0001X", desc: "Family Medicine", credential: "M.D." },
  { code: "SYNTH0002X", desc: "Internal Medicine", credential: "M.D." },
  { code: "SYNTH0003X", desc: "Pediatrics", credential: "D.O." },
  { code: "SYNTH0004X", desc: "Cardiovascular Disease", credential: "M.D." },
  { code: "SYNTH0005X", desc: "Nurse Practitioner, Family", credential: "NP" },
  { code: "SYNTH0006X", desc: "Physician Assistant", credential: "PA-C" },
  { code: "SYNTH0007X", desc: "Pharmacist", credential: "PHARMD" },
];
const ORGANIZATION_TYPES = [
  { code: "SYNTH0101X", desc: "General Acute Care Hospital", suffix: "HOSPITAL" },
  { code: "SYNTH0102X", desc: "Clinic/Center, Primary Care", suffix: "PRIMARY CARE CLINIC" },
  { code: "SYNTH0103X", desc: "Pharmacy, Community/Retail", suffix: "PHARMACY" },
  { code: "SYNTH0104X", desc: "Clinical Medical Laboratory", suffix: "LABORATORY" },
];

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic NPI: valid Luhn check digit over the 80840 prefix, first digit 0 so it is never a real NPI. */
export function syntheticNpi(serial: number): string {
  const body = `0${String(serial).padStart(8, "0")}`;
  const digits = `80840${body}`.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const DAY = 86_400_000;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function generateProviders(options: GenerateOptions = {}): Provider[] {
  const individuals = options.individuals ?? 40;
  const organizations = options.organizations ?? 15;
  const seed = options.seed ?? 1;
  if (!Number.isInteger(individuals) || individuals < 0 || individuals > 2000)
    throw new Error("nppes.generate.individuals must be an integer from 0 to 2000");
  if (!Number.isInteger(organizations) || organizations < 0 || organizations > 1000)
    throw new Error("nppes.generate.organizations must be an integer from 0 to 1000");
  if (!Number.isInteger(seed)) throw new Error("nppes.generate.seed must be an integer");
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const start = Date.parse("2006-01-01T00:00:00Z");

  const address = (purpose: "LOCATION" | "MAILING", place: (typeof PLACES)[number], line: string, phone: string) => ({
    address_1: line,
    address_purpose: purpose,
    address_type: "DOM",
    city: place.city,
    country_code: "US",
    country_name: "United States",
    postal_code: `${place.zip}${String(int(0, 9999)).padStart(4, "0")}`,
    state: place.state,
    telephone_number: phone,
  });
  const common = (n: number) => {
    const enumerated = start + int(0, 6500) * DAY;
    const updated = Math.min(enumerated + int(30, 3000) * DAY, Date.parse("2026-01-01T00:00:00Z"));
    const place = pick(PLACES);
    const phone = `555-01${String(int(0, 99)).padStart(2, "0")}`;
    const line = `${int(10, 999)} ${pick(STREETS)} ST`;
    return {
      enumerated,
      updated,
      place,
      record: {
        created_epoch: String(enumerated),
        last_updated_epoch: String(updated),
        number: syntheticNpi(n),
        addresses: [address("MAILING", place, line, phone), address("LOCATION", place, line, phone)],
        practiceLocations: [],
        identifiers: [],
        endpoints: [],
        other_names: [],
      },
    };
  };

  const providers: Provider[] = [];
  for (let n = 1; n <= individuals; n++) {
    const { enumerated, updated, place, record } = common(1000 + n);
    const type = pick(INDIVIDUAL_TYPES);
    const sex = pick(["F", "M"]);
    providers.push({
      ...record,
      enumeration_type: "NPI-1",
      basic: {
        first_name: pick(FIRST),
        last_name: pick(LAST),
        credential: type.credential,
        sole_proprietor: pick(["YES", "NO"]),
        sex,
        enumeration_date: date(enumerated),
        last_updated: date(updated),
        status: "A",
        name_prefix: "--",
        name_suffix: "--",
      },
      taxonomies: [
        { code: type.code, taxonomy_group: "", desc: type.desc, state: place.state, license: `SYN${n}`, primary: true },
      ],
    });
  }
  for (let n = 1; n <= organizations; n++) {
    const { enumerated, updated, place, record } = common(5000 + n);
    const type = pick(ORGANIZATION_TYPES);
    providers.push({
      ...record,
      enumeration_type: "NPI-2",
      basic: {
        organization_name: `${place.city} SYNTHETIC ${type.suffix}`,
        organizational_subpart: "NO",
        enumeration_date: date(enumerated),
        last_updated: date(updated),
        status: "A",
        authorized_official_first_name: pick(FIRST),
        authorized_official_last_name: pick(LAST),
        authorized_official_title_or_position: "Administrator",
        authorized_official_telephone_number: `55501${String(int(0, 99)).padStart(2, "0")}`,
        authorized_official_name_prefix: "--",
        authorized_official_name_suffix: "--",
      },
      taxonomies: [
        { code: type.code, taxonomy_group: "", desc: type.desc, state: place.state, license: "", primary: true },
      ],
    });
  }
  return providers;
}
