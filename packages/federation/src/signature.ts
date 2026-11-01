// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Draft-cavage HTTP Signatures (draft-cavage-http-signatures-12, as Mastodon speaks it; ADR 0030
 * decision 4) on Web Crypto RSASSA-PKCS1-v1_5 SHA-256.
 *
 * We sign `(request-target) host date digest` (no `digest` on a body-less GET) and emit
 * `Signature: keyId="…",algorithm="rsa-sha256",headers="…",signature="…"`. Inbound, we require
 * `(request-target)`, `host` and `date` to be covered (and `digest` whenever there is a body),
 * accept `rsa-sha256`, `hs2019` or no algorithm, and refuse a `Date` that is not an HTTP-date
 * (IMF-fixdate) or is outside the skew window, a digest that does not match the body, and a key
 * that does not belong to the actor: its `keyId` on another origin, or the fetched key document's
 * `owner` another actor (the caller passes that `owner` with the key).
 */
import { type Body, digest, fromBase64, toBase64, verifyDigest } from "./digest.ts";
import { checkKeyBits, importPrivateKeyPem, importPublicKeyPem, RSA_ALGORITHM } from "./keys.ts";

/**
 * ADR 0030 decision 4: 12 hours. Mirrors `FEDERATION_RULES.dateSkewSeconds` in
 * `@commonair/contracts` (not imported so this package stays dependency-free).
 */
export const DATE_SKEW_SECONDS = 43_200;
/** How far ahead of our clock a `Date` may be (Mastodon's clock-skew margin): one hour. */
export const FUTURE_SKEW_SECONDS = 3_600;
/** RFC 7231 section 7.1.1.1 IMF-fixdate, the only HTTP-date form senders generate. */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-3]\d (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} [0-2]\d:[0-5]\d:[0-6]\d GMT$/;
export const SIGNATURE_ALGORITHM = "rsa-sha256";
/** Algorithm names accepted inbound; `hs2019` means "derive it from the key" (RSA here). */
const ACCEPTED_ALGORITHMS = new Set([SIGNATURE_ALGORITHM, "hs2019"]);
const MAX_SIGNATURE_HEADER = 4096;

export type HeadersLike = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface SignRequestInput {
  method: string;
  url: string;
  /** Headers to send; `host`, `date`, `digest` and `signature` are set here. A given `date` is kept. */
  headers?: HeadersLike;
  /** Omitted for a body-less request (an actor fetch): then `digest` is neither set nor signed. */
  body?: Body;
  /** `<actor id>#main-key`. */
  keyId: string;
  /** The actor's private key, as a CryptoKey or PKCS#8 PEM. */
  privateKey: CryptoKey | string;
  /** Used for `date` when the headers carry none. */
  now?: Date;
}

export interface VerifyRequestInput {
  method: string;
  /** The URL as this server is addressed (its public origin), for `(request-target)` and `host`. */
  url: string;
  headers: HeadersLike;
  body?: Body;
}

/**
 * The sender's key as the caller fetched it by `keyId`: the public key, and the key document's
 * `owner` (the actor it belongs to). A key whose owner is not the request's actor is refused.
 */
export interface SenderKey {
  publicKey: string | CryptoKey;
  owner: string;
}

export interface VerifyOptions {
  now?: Date;
  /** Past skew; the future margin is the smaller of this and `FUTURE_SKEW_SECONDS`. */
  skewSeconds?: number;
  /** The actor the request speaks for; read from the body's `actor` when omitted. */
  actorId?: string;
}

export type SignatureError =
  /** No `Signature` (or `Authorization: Signature`) header. */
  | "missing_signature"
  | "malformed_signature"
  | "unsupported_algorithm"
  /** A required header is not covered, or a covered header is absent from the request. */
  | "missing_header"
  /** The `keyId` is not on the actor's origin, the key's owner is another actor, or there is no actor. */
  | "key_actor_mismatch"
  | "bad_date"
  | "date_skew"
  | "digest_mismatch"
  /** The signed `host` is not the host the request was addressed to. */
  | "host_mismatch"
  | "bad_key"
  | "bad_signature";

export type VerifyRequestResult =
  | { ok: true; keyId: string; actorId: string; headers: string[] }
  | { ok: false; error: SignatureError };

const enc = new TextEncoder();

/** Lower-cased header map; repeated values are joined with ", " as draft-cavage §2.3 says. */
export function normalizeHeaders(headers: HeadersLike | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!headers) return out;
  const add = (name: string, value: string) => {
    const key = name.toLowerCase();
    const prev = out.get(key);
    out.set(key, prev === undefined ? value.trim() : `${prev}, ${value.trim()}`);
  };
  if (headers instanceof Headers) headers.forEach((value, name) => add(name, value));
  else
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (typeof value === "string") add(name, value);
      else for (const v of value) add(name, v);
    }
  return out;
}

function requestTarget(method: string, url: URL): string {
  return `${method.toLowerCase()} ${url.pathname}${url.search}`;
}

/** The string draft-cavage signs: one `name: value` line per covered header, joined by "\n". */
export function signingString(
  method: string,
  url: string | URL,
  headers: Map<string, string>,
  covered: readonly string[],
): string | null {
  const u = typeof url === "string" ? new URL(url) : url;
  const lines: string[] = [];
  for (const name of covered) {
    if (name === "(request-target)") {
      lines.push(`(request-target): ${requestTarget(method, u)}`);
      continue;
    }
    const value = headers.get(name);
    if (value === undefined) return null;
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/** Sign a request; returns every header to send (lower-cased), including `signature`. */
export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const headers = normalizeHeaders(input.headers);
  headers.set("host", url.host);
  if (!headers.has("date")) headers.set("date", (input.now ?? new Date()).toUTCString());
  const covered = ["(request-target)", "host", "date"];
  if (input.body !== undefined) {
    headers.set("digest", await digest(input.body));
    covered.push("digest");
  } else headers.delete("digest");
  const text = signingString(input.method, url, headers, covered);
  // Every covered header was just set above.
  if (text === null) throw new Error("unreachable: covered header missing");
  const key = typeof input.privateKey === "string" ? await importPrivateKeyPem(input.privateKey) : input.privateKey;
  const sig = new Uint8Array(await crypto.subtle.sign(RSA_ALGORITHM, key, enc.encode(text)));
  if (/["\\]/.test(input.keyId)) throw new Error("keyId must not contain quotes or backslashes");
  headers.set(
    "signature",
    `keyId="${input.keyId}",algorithm="${SIGNATURE_ALGORITHM}",headers="${covered.join(" ")}",signature="${toBase64(sig)}"`,
  );
  return Object.fromEntries(headers);
}

export interface SignatureParams {
  keyId: string;
  algorithm: string | null;
  headers: string[];
  signature: string;
}

const PARAM = /\s*([A-Za-z]+)\s*=\s*"([^"]*)"\s*(?:,|$)/y;

/** Parse a `Signature` header value (or an `Authorization: Signature …` value). Null if malformed. */
export function parseSignatureHeader(value: string): SignatureParams | null {
  if (value.length > MAX_SIGNATURE_HEADER) return null;
  const v = value.replace(/^Signature\s+/i, "");
  const params = new Map<string, string>();
  PARAM.lastIndex = 0;
  while (PARAM.lastIndex < v.length) {
    const start = PARAM.lastIndex;
    const m = PARAM.exec(v);
    if (!m || m.index !== start) return null;
    const name = (m[1] as string).toLowerCase();
    if (params.has(name)) return null;
    params.set(name, m[2] as string);
  }
  const keyId = params.get("keyid");
  const signature = params.get("signature");
  if (!keyId || !signature) return null;
  const covered = (params.get("headers") ?? "date").toLowerCase().split(" ").filter(Boolean);
  if (covered.length === 0 || new Set(covered).size !== covered.length) return null;
  return { keyId, algorithm: params.get("algorithm")?.toLowerCase() ?? null, headers: covered, signature };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== "https:" && ua.protocol !== "http:") return false;
    return ua.origin === ub.origin;
  } catch {
    return false;
  }
}

function actorFromBody(body: Body | undefined): string | null {
  if (body === undefined) return null;
  try {
    const json: unknown = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    if (!json || typeof json !== "object") return null;
    const actor = (json as { actor?: unknown }).actor;
    if (typeof actor === "string") return actor;
    if (actor && typeof actor === "object" && typeof (actor as { id?: unknown }).id === "string")
      return (actor as { id: string }).id;
    return null;
  } catch {
    return null;
  }
}

/** Verify an inbound signed request against the sender's published public key. */
export async function verifyRequest(
  req: VerifyRequestInput,
  senderKey: SenderKey,
  opts: VerifyOptions = {},
): Promise<VerifyRequestResult> {
  const headers = normalizeHeaders(req.headers);
  const raw = headers.get("signature") ?? headers.get("authorization");
  if (raw === undefined) return { ok: false, error: "missing_signature" };
  if (!headers.has("signature") && !/^Signature\s/i.test(raw)) return { ok: false, error: "missing_signature" };
  const params = parseSignatureHeader(raw);
  if (!params) return { ok: false, error: "malformed_signature" };
  if (params.algorithm !== null && !ACCEPTED_ALGORITHMS.has(params.algorithm))
    return { ok: false, error: "unsupported_algorithm" };

  const hasBody = req.body !== undefined && !["GET", "HEAD"].includes(req.method.toUpperCase());
  const required = ["(request-target)", "host", "date", ...(hasBody ? ["digest"] : [])];
  if (required.some((h) => !params.headers.includes(h))) return { ok: false, error: "missing_header" };
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, error: "malformed_signature" };
  }
  const text = signingString(req.method, url, headers, params.headers);
  if (text === null) return { ok: false, error: "missing_header" };

  const actorId = opts.actorId ?? actorFromBody(req.body);
  if (!actorId || !sameOrigin(params.keyId, actorId) || senderKey.owner !== actorId)
    return { ok: false, error: "key_actor_mismatch" };

  const rawDate = headers.get("date") ?? "";
  const date = IMF_FIXDATE.test(rawDate) ? Date.parse(rawDate) : Number.NaN;
  if (Number.isNaN(date)) return { ok: false, error: "bad_date" };
  const now = (opts.now ?? new Date()).getTime();
  const skew = opts.skewSeconds ?? DATE_SKEW_SECONDS;
  if (now - date > skew * 1000 || date - now > Math.min(skew, FUTURE_SKEW_SECONDS) * 1000)
    return { ok: false, error: "date_skew" };

  if (hasBody && !(await verifyDigest(headers.get("digest") ?? "", req.body as Body)))
    return { ok: false, error: "digest_mismatch" };
  if ((headers.get("host") ?? "").toLowerCase() !== url.host.toLowerCase())
    return { ok: false, error: "host_mismatch" };

  let key: CryptoKey;
  try {
    const k = senderKey.publicKey;
    key = typeof k === "string" ? await importPublicKeyPem(k) : checkKeyBits(k);
  } catch {
    return { ok: false, error: "bad_key" };
  }
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64(params.signature);
  } catch {
    return { ok: false, error: "malformed_signature" };
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(RSA_ALGORITHM, key, sig, enc.encode(text));
  } catch {
    return { ok: false, error: "bad_key" };
  }
  if (!valid) return { ok: false, error: "bad_signature" };
  return { ok: true, keyId: params.keyId, actorId, headers: params.headers };
}
