// The shared synthetic population (decision 0018): one top-level `population` key gives every patient-centric
// service the same people, by turning it into that service's generator options.

export interface PopulationConfig {
  /** Number of people, 0 to 1000. Default 5. */
  patients?: number;
  /** PRNG seed; the same seed always gives the same people. Default 1. */
  seed?: number;
  /** Date the records are relative to (YYYY-MM-DD). Default 2026-01-01. */
  referenceDate?: string;
}

/** Services whose `generate` takes the FHIR generator's options directly. */
const GENERATOR_SERVICES = new Set([
  "fhir",
  "epic",
  "cerner",
  "athena",
  "bluebutton",
  "redox",
  "cdshooks",
  "stedi",
  "availity",
  "dexcom",
  "fitbit",
  "oura",
  "withings",
  "terra",
  "hl7v2",
]);

export const POPULATION_SERVICES = [...GENERATOR_SERVICES, "rave"];

export function validatePopulation(value: unknown): PopulationConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("population must be an object with patients, seed, and referenceDate");
  const { patients, seed, referenceDate, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error(`population: unknown option ${Object.keys(rest).join(", ")}`);
  if (
    patients !== undefined &&
    (!Number.isInteger(patients) || (patients as number) < 0 || (patients as number) > 1000)
  )
    throw new Error("population.patients must be an integer from 0 to 1000");
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error("population.seed must be an integer");
  if (referenceDate !== undefined && (typeof referenceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)))
    throw new Error("population.referenceDate must be a YYYY-MM-DD date");
  return value as PopulationConfig;
}

/**
 * A service's seed config with the shared population applied. A service's own `generate` setting wins, so one
 * service can still be configured apart from the rest.
 */
export function applyPopulation(
  service: string,
  config: Record<string, unknown> | undefined,
  population: PopulationConfig | undefined,
): Record<string, unknown> | undefined {
  if (!population) return config;
  const own = config?.generate;
  if (GENERATOR_SERVICES.has(service)) return own === undefined ? { ...config, generate: { ...population } } : config;
  if (service === "rave") {
    if (own === false) return config;
    const generate = (own ?? {}) as Record<string, unknown>;
    return generate.population === undefined
      ? { ...config, generate: { ...generate, population: { ...population } } }
      : config;
  }
  return config;
}
