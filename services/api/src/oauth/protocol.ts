// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure protocol helpers for the machine OAuth endpoints (RFC 6749, 7009, 8628): parameter
 * parsing, client credential extraction, RFC error responses, user codes and redirect URLs.
 * Nothing here touches the database, so the unit tests cover it exhaustively.
 */
import { OAUTH_ERROR_CODES, USER_CODE_ALPHABET } from "@commonair/contracts/oauth";

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** An RFC 6749 §5.2 error. Descriptions are fixed English API reference text, never user input. */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly opts: { status?: number; basicChallenge?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(code);
    this.name = "OAuthError";
  }
  get status(): number {
    return this.opts.status ?? (this.code === "invalid_client" ? 401 : 400);
  }
  get basicChallenge(): boolean {
    return this.opts.basicChallenge === true;
  }
}

export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

export function oauthErrorResponse(err: OAuthError): Response {
  const headers: Record<string, string> = { ...NO_STORE };
  // RFC 6749 §5.2: a client that tried HTTP Basic gets the matching challenge back.
  if (err.basicChallenge) headers["www-authenticate"] = 'Basic realm="oauth2"';
  if (err.opts.retryAfterSeconds !== undefined) headers["retry-after"] = String(err.opts.retryAfterSeconds);
  return Response.json({ error: err.code, error_description: err.description }, { status: err.status, headers });
}

export const MAX_BODY_BYTES = 16 * 1024;

/** Parse one source; a parameter sent twice is an error (RFC 6749 §3.1, §3.2). */
function parseOnce(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of search) {
    if (Object.hasOwn(out, k)) throw new OAuthError("invalid_request", "A parameter was sent more than once");
    out[k] = v;
  }
  return out;
}

/**
 * Request parameters: the `application/x-www-form-urlencoded` body, else the query string (Twitch
 * libraries send the query). Where both carry a parameter, the body wins. Empty values count as
 * absent (RFC 6749 §3.1).
 */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const query = parseOnce(new URL(req.url).searchParams);
  let body: Record<string, string> = {};
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "The request body is too large");
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "The request body is too large");
    body = parseOnce(new URLSearchParams(text));
  }
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...query, ...body })) if (v !== "") merged[k] = v;
  return merged;
}

export interface ClientCredentials {
  clientId: string;
  secret: string | null;
  method: "basic" | "post" | "none";
}

/** `application/x-www-form-urlencoded` decoding of one Basic credential half (RFC 6749 §2.3.1). */
function formDecode(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

/**
 * Client credentials from `Authorization: Basic` (`client_secret_basic`, each half form-encoded
 * per RFC 6749 §2.3.1) or the parameters (`client_secret_post`, or a public client's bare
 * `client_id`). Using both methods at once is `invalid_request` (RFC 6749 §2.3).
 */
export function clientCredentials(headers: Headers, params: Record<string, string>): ClientCredentials {
  const auth = headers.get("authorization");
  const basic = auth ? /^Basic\s+(\S+)$/i.exec(auth.trim()) : null;
  if (auth && !basic) throw new OAuthError("invalid_client", "Unsupported client authentication scheme");
  if (basic?.[1]) {
    let decoded: string;
    let id: string;
    let secret: string;
    try {
      decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) throw new Error("no colon");
      id = formDecode(decoded.slice(0, i));
      secret = formDecode(decoded.slice(i + 1));
    } catch {
      throw new OAuthError("invalid_client", "Malformed client credentials", { basicChallenge: true });
    }
    if (params.client_secret !== undefined)
      throw new OAuthError("invalid_request", "Use one client authentication method, not two");
    if (params.client_id !== undefined && params.client_id !== id)
      throw new OAuthError("invalid_request", "client_id does not match the authenticated client");
    if (id === "") throw new OAuthError("invalid_client", "Malformed client credentials", { basicChallenge: true });
    return { clientId: id, secret, method: "basic" };
  }
  const id = params.client_id;
  if (id === undefined) throw new OAuthError("invalid_request", "client_id is required");
  const secret = params.client_secret;
  return secret === undefined
    ? { clientId: id, secret: null, method: "none" }
    : { clientId: id, secret, method: "post" };
}

/** Largest multiple of the alphabet size below 256: bytes at or above it are rejected (no modulo bias). */
export const USER_CODE_BYTE_LIMIT = 256 - (256 % USER_CODE_ALPHABET.length);

/**
 * An RFC 8628 §6.1 user code: 8 characters from `USER_CODE_ALPHABET`, uniformly, by rejection
 * sampling over `crypto.getRandomValues` bytes. `random` is injectable for the bias test.
 */
export function generateUserCode(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = "";
  while (out.length < 8) {
    for (const b of random(16)) {
      if (b >= USER_CODE_BYTE_LIMIT) continue;
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === 8) break;
    }
  }
  return out;
}

/** `BCDFGHJK` → `BCDF-GHJK`, as users see it. */
export const formatUserCode = (normalized: string) => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

/**
 * The redirect back to the client: the presented redirect URI (already matched against a
 * registered one) with its own query kept and `params` appended (OAuth 2.1 §4.1.2). Built with
 * `URL`, so values are encoded.
 */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.append(k, v);
  return url.href;
}
