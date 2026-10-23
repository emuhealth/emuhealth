// A dependency free SMART App Launch client: discovery, PKCE, the token exchange, and FHIR reads.
import { createHash, randomBytes } from "node:crypto";

export interface SmartConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface TokenResponse {
  access_token: string;
  scope: string;
  patient?: string;
}

export async function discover(fhirBase: string): Promise<SmartConfiguration> {
  const res = await fetch(`${fhirBase}/.well-known/smart-configuration`);
  if (!res.ok) throw new Error(`SMART discovery failed with ${res.status}`);
  return (await res.json()) as SmartConfiguration;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(
  config: SmartConfiguration,
  options: { fhirBase: string; clientId: string; redirectUri: string; scope: string; state: string; challenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scope,
    state: options.state,
    aud: options.fhirBase,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
  });
  return `${config.authorization_endpoint}?${params}`;
}

export async function exchangeCode(
  config: SmartConfiguration,
  options: { code: string; clientId: string; redirectUri: string; verifier: string },
): Promise<TokenResponse> {
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier,
    }),
  });
  const body = (await res.json()) as TokenResponse & { error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Token exchange failed: ${body.error ?? res.status}`);
  return body;
}

export interface PatientSummary {
  id: string;
  name: string;
  birthDate?: string;
  conditions: string[];
  medications: string[];
}

type Bundle = { entry?: { resource: Record<string, any> }[] };

export async function patientSummary(fhirBase: string, token: TokenResponse): Promise<PatientSummary> {
  if (!token.patient) throw new Error("The token has no patient in context");
  const get = async (path: string) => {
    const res = await fetch(`${fhirBase}/${path}`, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/fhir+json" },
    });
    if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}`);
    return res.json() as Promise<any>;
  };
  const id = token.patient;
  const patient = await get(`Patient/${id}`);
  const resources = (bundle: Bundle) => (bundle.entry ?? []).map((e) => e.resource);
  // Epic adds an informational OperationOutcome to searches without matches, so keep only the requested type.
  const conditions = resources(await get(`Condition?patient=${id}`)).filter((r) => r.resourceType === "Condition");
  const medications = resources(await get(`MedicationRequest?patient=${id}`)).filter(
    (r) => r.resourceType === "MedicationRequest",
  );
  const name = patient.name?.[0];
  return {
    id,
    name: [...(name?.given ?? []), name?.family].filter(Boolean).join(" "),
    birthDate: patient.birthDate,
    conditions: conditions.map((c) => c.code?.text ?? c.code?.coding?.[0]?.display ?? "Unnamed condition"),
    medications: medications.map(
      (m) =>
        m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? "Unnamed medication",
    ),
  };
}
