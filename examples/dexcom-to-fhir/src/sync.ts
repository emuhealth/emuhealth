// Copies continuous glucose readings from the Dexcom API into a FHIR server as Observations. Each reading gets an
// identifier, and a conditional create skips readings already copied, so running the sync again is safe.

export interface DexcomApp {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const authorizeUrl = (app: DexcomApp, state: string) =>
  `${app.baseUrl}/v2/oauth2/login?${new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: "offline_access",
    state,
  })}`;

export async function exchangeCode(app: DexcomApp, code: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/v2/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`Dexcom token exchange failed with ${res.status}`);
  return body.access_token;
}

interface Egv {
  systemTime: string;
  value: number;
  trend: string;
  transmitterId?: string;
}

const LOINC_CGM = {
  system: "http://loinc.org",
  code: "99504-3",
  display: "Glucose [Mass/volume] in Interstitial fluid",
};
const READING_ID = "urn:emuhealth:example:dexcom-egv";

/** Copy one window of readings (at most 30 days, Dexcom's limit) for a patient; returns how many were new. */
export async function syncGlucose(options: {
  dexcomUrl: string;
  token: string;
  fhirBase: string;
  patientId: string;
  start: string;
  end: string;
}): Promise<number> {
  const egvs = await fetch(
    `${options.dexcomUrl}/v3/users/self/egvs?${new URLSearchParams({ startDate: options.start, endDate: options.end })}`,
    { headers: { Authorization: `Bearer ${options.token}` } },
  );
  if (!egvs.ok) throw new Error(`Dexcom returned ${egvs.status}`);
  const { userId, records } = (await egvs.json()) as { userId: string; records: Egv[] };
  const bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: records.map((r) => {
      const identifier = `${userId}/${r.systemTime}`;
      return {
        resource: {
          resourceType: "Observation",
          identifier: [{ system: READING_ID, value: identifier }],
          status: "final",
          category: [
            { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] },
          ],
          code: { coding: [LOINC_CGM], text: "Sensor glucose" },
          subject: { reference: `Patient/${options.patientId}` },
          effectiveDateTime: `${r.systemTime}Z`,
          valueQuantity: { value: r.value, unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" },
          ...(r.transmitterId ? { device: { display: `Dexcom transmitter ${r.transmitterId}` } } : {}),
          note: [{ text: `Trend: ${r.trend}` }],
        },
        request: { method: "POST", url: "Observation", ifNoneExist: `identifier=${READING_ID}|${identifier}` },
      };
    }),
  };
  const res = await fetch(options.fhirBase, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(bundle),
  });
  const result = (await res.json()) as { entry?: Array<{ response: { status: string } }> };
  if (!res.ok) throw new Error(`FHIR transaction failed with ${res.status}: ${JSON.stringify(result)}`);
  return (result.entry ?? []).filter((e) => e.response.status.startsWith("201")).length;
}
