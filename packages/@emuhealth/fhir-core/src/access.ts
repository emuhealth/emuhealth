import type { Store } from "@emulators/core";
import { FhirError } from "./outcome.js";
import { parseSearch, parseReference, runSearch, type SearchContext } from "./search.js";
import { findAccessToken, getSmartConfig, type SmartToken } from "./smart.js";
import type { FhirResource } from "./store.js";

// SMART scope enforcement (decision 0010).

/** SMART v2 interaction letters: create, read, update, delete, search. */
export type Interaction = "c" | "r" | "u" | "d" | "s";

export interface ScopeGrant {
  context: "patient" | "user" | "system";
  /** Resource type or "*". */
  type: string;
  interactions: Set<Interaction>;
  /** SMART v2 granular constraints, for example [["category", "laboratory"]]. */
  constraints: Array<[string, string]>;
}

const SCOPE_PATTERN = /^(patient|user|system)\/(\*|[A-Z][A-Za-z]+)\.([a-z*]+)(?:\?(.*))?$/;

/** Parse SMART v1 (read, write, *) and v2 (cruds subsets, ?constraints) resource scopes. Other scopes are ignored. */
export function parseScopes(scope: string): ScopeGrant[] {
  const grants: ScopeGrant[] = [];
  for (const raw of scope.split(/\s+/).filter(Boolean)) {
    const match = SCOPE_PATTERN.exec(raw);
    if (!match) continue;
    const [, context, type, access, query] = match;
    let interactions: Interaction[];
    if (access === "read") interactions = ["r", "s"];
    else if (access === "write") interactions = ["c", "u", "d"];
    else if (access === "*") interactions = ["c", "r", "u", "d", "s"];
    else if (/^c?r?u?d?s?$/.test(access) && access.length > 0) interactions = [...access] as Interaction[];
    else continue;
    grants.push({
      context: context as ScopeGrant["context"],
      type,
      interactions: new Set(interactions),
      constraints: query ? [...new URLSearchParams(query)] : [],
    });
  }
  return grants;
}

/** Every reference target ("Type/id") anywhere in a resource. */
function referenceKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) referenceKeys(v, out);
  else if (value && typeof value === "object")
    for (const [name, child] of Object.entries(value)) {
      if (name === "reference" && typeof child === "string") {
        const target = parseReference(child);
        if (target) out.add(`${target[0]}/${target[1]}`);
      } else referenceKeys(child, out);
    }
  return out;
}

/** In the patient's compartment: the Patient itself, or any resource that references it. */
export function inPatientCompartment(resource: FhirResource, patient: string): boolean {
  if (resource.resourceType === "Patient") return resource.id === patient;
  return referenceKeys(resource).has(`Patient/${patient}`);
}

/** What one request may do. Unrestricted when no token was presented in permissive mode. */
export interface AccessGuard {
  readonly token?: SmartToken;
  /** Throw 403 unless some scope grants this interaction on the type. */
  require(type: string, interaction: Interaction): void;
  /** Whether a resource is visible for the interaction: patient compartment and granular constraints. */
  allows(resource: FhirResource, interaction: Interaction): boolean;
  /** Throw 403 when a resource being written falls outside what the token may write. */
  requireWritable(resource: FhirResource, interaction: Interaction): void;
}

export const UNRESTRICTED: AccessGuard = {
  require() {},
  allows: () => true,
  requireWritable() {},
};

const INTERACTION_NAMES: Record<Interaction, string> = {
  c: "create",
  r: "read",
  u: "update",
  d: "delete",
  s: "search",
};

function forbidden(message: string): FhirError {
  return new FhirError(403, "forbidden", message);
}

export function guardForToken(token: SmartToken, ctx: SearchContext): AccessGuard {
  const grants = parseScopes(token.scope);
  const matching = (type: string, interaction: Interaction) =>
    grants.filter((g) => (g.type === "*" || g.type === type) && g.interactions.has(interaction));

  function allows(resource: FhirResource, interaction: Interaction): boolean {
    return matching(resource.resourceType, interaction).some((grant) => {
      if (grant.context === "patient") {
        // A patient scope without a patient in context grants nothing.
        if (!token.patient || !inPatientCompartment(resource, token.patient)) return false;
      }
      if (grant.constraints.length === 0) return true;
      const parsed = parseSearch(resource.resourceType, grant.constraints);
      return runSearch([resource], parsed, ctx).total === 1;
    });
  }

  return {
    token,
    require(type, interaction) {
      if (matching(type, interaction).length === 0)
        throw forbidden(`The token's scopes do not allow ${INTERACTION_NAMES[interaction]} on ${type}`);
    },
    allows,
    requireWritable(resource, interaction) {
      if (!allows(resource, interaction))
        throw forbidden(
          `The token may not ${INTERACTION_NAMES[interaction]} this ${resource.resourceType} (outside its patient or scope constraints)`,
        );
    },
  };
}

/**
 * Resolve the guard for a request. No token: unrestricted, or 401 in strict mode (fhir.smart.required).
 * A token that is not a live SMART access token is always 401.
 */
export function resolveAccess(store: Store, authorization: string | undefined, ctx: SearchContext): AccessGuard {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) {
    if (getSmartConfig(store).required)
      throw new FhirError(401, "login", "A SMART access token is required (fhir.smart.required is on)", {
        "WWW-Authenticate": 'Bearer realm="fhir"',
      });
    return UNRESTRICTED;
  }
  const token = findAccessToken(store, bearer);
  if (!token)
    throw new FhirError(401, "login", "The access token is invalid or expired", {
      "WWW-Authenticate": 'Bearer realm="fhir", error="invalid_token"',
    });
  return guardForToken(token, ctx);
}
