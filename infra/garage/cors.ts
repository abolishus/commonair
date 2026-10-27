// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CORS on the media bucket for the development stack only. In production the browser reaches
 * Garage through Caddy on the site's own origin (ADR 0024), so no rule is needed. In
 * `podman compose` the web app is on localhost:3000 and Garage on localhost:3900: a presigned
 * PUT from the browser is cross-origin and its preflight needs a rule. Garage's admin API has no
 * CORS setting, so this is the S3 PutBucketCors call, signed with SigV4 by hand (Bun's S3 client
 * only signs object requests).
 */
import { createHash, createHmac } from "node:crypto";

/** A rule for presigned uploads (PUT) and downloads (GET, HEAD) from the given origins. */
export function corsXml(origins: readonly string[]): string {
  const allowed = origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join("");
  return (
    `<CORSConfiguration><CORSRule>${allowed}` +
    "<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>" +
    "<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>" +
    "</CORSRule></CORSConfiguration>"
  );
}

/** Origins from a comma-separated list; each must be a bare http(s) origin. */
export function parseOrigins(value: string | undefined): string[] {
  const origins = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of origins) {
    const u = URL.parse(o);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== o)
      throw new Error(`GARAGE_CORS_ORIGINS: ${o} is not an origin like http://localhost:3000`);
  }
  return origins;
}

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export interface PutCorsInput {
  /** Path-style S3 endpoint, e.g. http://garage:3900. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  origins: readonly string[];
  now?: Date;
}

/** The signed `PUT /<bucket>?cors` request (SigV4, header auth, path style). */
export function putBucketCorsRequest(input: PutCorsInput): Request {
  const body = corsXml(input.origins);
  const url = new URL(`/${encodeURIComponent(input.bucket)}?cors`, input.endpoint);
  const amzDate = (input.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signed = Object.keys(headers).sort();
  const canonical = [
    "PUT",
    url.pathname,
    "cors=",
    ...signed.map((h) => `${h}:${headers[h]}`),
    "",
    signed.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = ["s3", "aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region),
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return new Request(url, {
    method: "PUT",
    body,
    headers: {
      ...headers,
      "content-type": "application/xml",
      "content-md5": createHash("md5").update(body).digest("base64"),
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
    },
  });
}

/** The dev-only rule from compose's garage-init environment, or null when it is not asked for. */
export function corsFromEnv(env: Record<string, string | undefined>): Omit<PutCorsInput, "now"> | null {
  const origins = parseOrigins(env.GARAGE_CORS_ORIGINS);
  if (origins.length === 0) return null;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required with GARAGE_CORS_ORIGINS`);
    return v;
  };
  return {
    endpoint: env.GARAGE_S3_URL || "http://garage:3900",
    region: env.S3_REGION || "garage",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    bucket: env.S3_BUCKET_MEDIA || "commonair-media",
    origins,
  };
}

export async function putBucketCors(input: PutCorsInput, doFetch: typeof fetch = fetch): Promise<void> {
  const res = await doFetch(putBucketCorsRequest(input));
  if (!res.ok) throw new Error(`PutBucketCors on ${input.bucket}: HTTP ${res.status} ${await res.text()}`);
}
