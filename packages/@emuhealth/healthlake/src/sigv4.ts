import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// AWS Signature Version 4 verification for requests signed by the AWS SDKs and CLI (header signing, not presigned
// URLs). It rebuilds the canonical request the way the SDK does and compares signatures.

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Result {
  ok: boolean;
  /** AWS error type and message when the request does not verify. */
  error?: { type: string; message: string };
  accessKeyId?: string;
  region?: string;
}

/** RFC 3986 encoding, as SigV4 requires. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

const MAX_SKEW_MS = 15 * 60_000;

export async function verifySigV4(
  request: Request,
  service: string,
  credentials: Credentials[],
  now: number = Date.now(),
): Promise<SigV4Result> {
  const fail = (type: string, message: string): SigV4Result => ({ ok: false, error: { type, message } });
  const header = request.headers.get("authorization") ?? "";
  const match =
    /^AWS4-HMAC-SHA256\s+Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
      header.trim(),
    );
  if (!match) return fail("MissingAuthenticationTokenException", "Missing Authentication Token");
  const [, accessKeyId, date, region, signedService, signedHeaderList, signature] = match;
  if (signedService !== service)
    return fail("InvalidSignatureException", `Credential should be scoped to correct service: '${service}'.`);
  const credential = credentials.find((c) => c.accessKeyId === accessKeyId);
  if (!credential) return fail("UnrecognizedClientException", "The security token included in the request is invalid.");

  const amzDate = request.headers.get("x-amz-date") ?? "";
  const parsed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!parsed)
    return fail(
      "IncompleteSignatureException",
      "Authorization header requires existence of either a 'X-Amz-Date' or a 'Date' header.",
    );
  const signedAt = Date.UTC(+parsed[1], +parsed[2] - 1, +parsed[3], +parsed[4], +parsed[5], +parsed[6]);
  if (Math.abs(now - signedAt) > MAX_SKEW_MS)
    return fail("InvalidSignatureException", "Signature expired: the request time is too far from the server time.");
  if (amzDate.slice(0, 8) !== date)
    return fail(
      "InvalidSignatureException",
      "Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP.",
    );

  const url = new URL(request.url);
  const canonicalPath =
    url.pathname
      .split("/")
      .map((segment) => encode(decodeURIComponent(segment)))
      .join("/") || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signedHeaders = signedHeaderList.split(";");
  const canonicalHeaders = signedHeaders
    .map((name) => {
      const value = name === "host" ? (request.headers.get("host") ?? url.host) : (request.headers.get(name) ?? "");
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const payloadHash = request.headers.get("x-amz-content-sha256") ?? sha256(body);
  const canonicalRequest = [
    request.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credential.secretAccessKey}`, date), region), service), "aws4_request");
  const expected = createHmac("sha256", key).update(stringToSign).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
    return fail(
      "InvalidSignatureException",
      "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
    );
  return { ok: true, accessKeyId, region };
}
