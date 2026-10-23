// Gets a SMART access token from a running emuhealth FHIR service by walking the authorize flow the way a
// browser would: open the authorize page, choose the first practitioner, and exchange the code with PKCE.
// Usage: node tests/inferno/get-token.mjs [baseUrl] [scope]
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:4100";
const scope = process.argv[3] ?? "openid fhirUser user/*.read";
const redirectUri = "http://localhost:3000/callback";
const clientId = "inferno-gate";

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const authorize = await fetch(
  `${base}/auth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    aud: base,
    scope,
    state: "gate",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`,
);
const html = await authorize.text();
const request = html.match(/name="request" value="([^"]*)"/)?.[1];
const practitioner = html.match(/name="practitioner" value="([^"]*)"/)?.[1];
if (!request || !practitioner) throw new Error(`Unexpected authorize page (${authorize.status})`);

const select = await fetch(`${base}/auth/authorize/select`, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ request, practitioner }),
});
const code = new URL(select.headers.get("Location") ?? "").searchParams.get("code");
if (!code) throw new Error(`No authorization code (${select.status})`);

const token = await fetch(`${base}/auth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }),
});
const body = await token.json();
if (!body.access_token) throw new Error(`Token request failed: ${JSON.stringify(body)}`);
process.stdout.write(body.access_token);
