// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.1 helpers for apps and bots (ADR 0027 §1-2): PKCE (`S256` only), the authorize URL, the
 * token endpoint (code, refresh, client credentials), revocation, the RFC 8628 device flow, and a
 * refreshing token source that rotates refresh tokens safely. The machine endpoints are
 * form-encoded; confidential clients authenticate with `client_secret_post`.
 */
import {
  DEVICE_CODE_GRANT,
  DeviceAuthorizationResponse,
  OAUTH_LIMITS,
  OAUTH_PATHS,
  OAuthErrorResponse,
  TokenResponse,
  pkceChallenge,
} from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import { type FetchLike, trimBase } from "./client.ts";
import { OAuthError, ReauthorizeError } from "./errors.ts";

/** RFC 3986 §2.3 unreserved characters, the PKCE verifier alphabet. */
const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const VERIFIER_LENGTH = 64;

export interface PkcePair {
  /** Keep secret until the code exchange. */
  verifier: string;
  challenge: string;
  method: "S256";
}

/** A fresh PKCE pair: 64 uniformly random unreserved characters and their S256 challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  // Rejection sampling: 66 symbols, so only bytes below 198 (3 × 66) map without bias.
  const limit = Math.floor(256 / UNRESERVED.length) * UNRESERVED.length;
  let verifier = "";
  while (verifier.length < VERIFIER_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(VERIFIER_LENGTH))) {
      if (b >= limit) continue;
      verifier += UNRESERVED[b % UNRESERVED.length];
      if (verifier.length === VERIFIER_LENGTH) break;
    }
  }
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}

export interface AuthorizeUrlOptions {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly (Scope | (string & {}))[];
  /** Opaque; check it on the redirect (CSRF). */
  state: string;
  codeChallenge: string;
  /** Show the consent page even when the user already granted these scopes. */
  forceVerify?: boolean;
}

/** The consent page URL to send the user's browser to. */
export function authorizeUrl(opts: AuthorizeUrlOptions): string {
  const url = new URL(`${trimBase(opts.baseUrl)}${OAUTH_PATHS.authorizePage}`);
  const q = url.searchParams;
  q.set("client_id", opts.clientId);
  q.set("redirect_uri", opts.redirectUri);
  q.set("response_type", "code");
  q.set("scope", opts.scopes.join(" "));
  q.set("state", opts.state);
  q.set("code_challenge", opts.codeChallenge);
  q.set("code_challenge_method", "S256");
  if (opts.forceVerify) q.set("force_verify", "true");
  return url.toString();
}

/** A token endpoint answer, normalized. Never log it. */
export interface TokenSet {
  accessToken: string;
  /** Absent for client credentials. */
  refreshToken: string | null;
  /** Milliseconds since the epoch, computed from `expires_in` on receipt. */
  expiresAt: number;
  /** The granted scopes (may be fewer than requested). */
  scopes: string[];
}

interface Endpoint {
  baseUrl: string;
  clientId: string;
  /** Confidential clients only; sent as `client_secret` in the form (`client_secret_post`). */
  clientSecret?: string | null;
  fetch?: FetchLike;
  /** Clock for `expiresAt` (tests). */
  now?: () => number;
}

async function postForm(ep: Endpoint, path: string, params: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams({ ...params, client_id: ep.clientId });
  if (ep.clientSecret) form.set("client_secret", ep.clientSecret);
  const request = new Request(`${trimBase(ep.baseUrl)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  return (ep.fetch ?? ((r) => fetch(r)))(request);
}

async function jsonOf(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Throw the endpoint's OAuth error, or `invalid_response` when the body is not one. */
function refusal(res: Response, body: unknown): never {
  const e = OAuthErrorResponse.safeParse(body);
  if (e.success) throw new OAuthError(e.data.error, e.data.error_description, res.status);
  throw new OAuthError("invalid_response", `HTTP ${res.status}`, res.status);
}

async function tokenRequest(ep: Endpoint, params: Record<string, string>): Promise<TokenSet> {
  const res = await postForm(ep, OAUTH_PATHS.token, params);
  const body = await jsonOf(res);
  if (!res.ok) refusal(res, body);
  const t = TokenResponse.safeParse(body);
  if (!t.success) throw new OAuthError("invalid_response", "not a token response", res.status);
  return {
    accessToken: t.data.access_token,
    refreshToken: t.data.refresh_token ?? null,
    expiresAt: (ep.now ?? Date.now)() + t.data.expires_in * 1000,
    scopes: t.data.scope.split(" ").filter((s) => s !== ""),
  };
}

/** Redeem an authorization code (with the PKCE verifier it was requested with). */
export function exchangeCode(
  opts: Endpoint & { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenSet> {
  return tokenRequest(opts, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

/**
 * Rotate a refresh token. The old refresh token is dead afterwards: persist the new pair before
 * using it, and never retry with the old one (a replay revokes the whole grant).
 */
export function refresh(opts: Endpoint & { refreshToken: string }): Promise<TokenSet> {
  return tokenRequest(opts, { grant_type: "refresh_token", refresh_token: opts.refreshToken });
}

/** An app token (no user, no scopes) for a confidential client. */
export function clientCredentials(opts: Endpoint & { clientSecret: string }): Promise<TokenSet> {
  return tokenRequest(opts, { grant_type: "client_credentials" });
}

/** RFC 7009: revoke an access token, or a refresh token (which revokes its whole family). */
export async function revoke(
  opts: Endpoint & { token: string; tokenTypeHint?: "access_token" | "refresh_token" },
): Promise<void> {
  const params: Record<string, string> = { token: opts.token };
  if (opts.tokenTypeHint) params.token_type_hint = opts.tokenTypeHint;
  const res = await postForm(opts, OAUTH_PATHS.revoke, params);
  const body = await jsonOf(res);
  if (!res.ok) refusal(res, body);
}

export interface DeviceCode {
  /** What the user types at `verificationUri` (shown as XXXX-XXXX). */
  userCode: string;
  verificationUri: string;
  /** `verificationUri` with the code filled in (good for a QR code or a link). */
  verificationUriComplete: string;
  expiresIn: number;
}

export interface DeviceFlowOptions extends Endpoint {
  scopes: readonly (Scope | (string & {}))[];
  /** Show the code to the user. Polling starts once this returns (or its promise settles). */
  onCode: (code: DeviceCode) => void | Promise<void>;
  signal?: AbortSignal;
  /** Waits between polls (tests replace it). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/** An abortable wait. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * RFC 8628 device flow: request a code, hand it to `onCode`, then poll the token endpoint every
 * `interval` seconds (5 more after each `slow_down`) until the user approves. Throws `OAuthError`
 * `access_denied` or `expired_token`, or the abort reason.
 */
export async function deviceFlow(opts: DeviceFlowOptions): Promise<TokenSet> {
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const res = await postForm(opts, OAUTH_PATHS.device, { scope: opts.scopes.join(" ") });
  const body = await jsonOf(res);
  if (!res.ok) refusal(res, body);
  const d = DeviceAuthorizationResponse.safeParse(body);
  if (!d.success) throw new OAuthError("invalid_response", "not a device authorization response", res.status);
  const deadline = now() + d.data.expires_in * 1000;
  await opts.onCode({
    userCode: d.data.user_code,
    verificationUri: d.data.verification_uri,
    verificationUriComplete: d.data.verification_uri_complete,
    expiresIn: d.data.expires_in,
  });
  let interval = d.data.interval;
  for (;;) {
    await wait(interval * 1000, opts.signal);
    if (opts.signal?.aborted) throw abortError(opts.signal);
    if (now() >= deadline) throw new OAuthError("expired_token", "the device code expired", 0);
    try {
      return await tokenRequest(opts, { grant_type: DEVICE_CODE_GRANT, device_code: d.data.device_code });
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += OAUTH_LIMITS.deviceSlowDownSeconds;
        continue;
      }
      throw err;
    }
  }
}

/** What a `TokenStore` keeps. Treat it as a secret. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  scopes?: string[];
}

/** Where `refreshingToken` reads the current pair and persists each rotated one. */
export interface TokenStore {
  load(): StoredTokens | null | Promise<StoredTokens | null>;
  /** Called with every rotated pair before it is used: the old refresh token is already dead. */
  save(tokens: StoredTokens): void | Promise<void>;
}

/** A `TokenStore` that keeps the pair in memory (and optionally reports each rotation). */
export function memoryStore(initial: StoredTokens | null, onSave?: (t: StoredTokens) => void): TokenStore {
  let current = initial;
  return {
    load: () => current,
    save(t) {
      current = t;
      onSave?.(t);
    },
  };
}

export interface RefreshingTokenOptions extends Endpoint {
  store: TokenStore;
  /** Refresh this many seconds before expiry (default 60). */
  refreshAheadSeconds?: number;
}

/** `getToken()` for `createClient`, with a manual refresh for tests and recovery. */
export interface RefreshingToken {
  (): Promise<string>;
  /** Rotate now (at most one rotation runs at a time; concurrent callers share it). */
  refresh(): Promise<string>;
}

/**
 * A token source that refreshes ahead of expiry, runs at most one refresh at a time, persists every
 * rotated pair through `store.save()` before handing the new token out, and on `invalid_grant`
 * throws `ReauthorizeError` from then on (the old refresh token must never be retried).
 *
 * A refresh does not end a bound EventSub WebSocket session: the server keeps sessions bound to the
 * grant, and later `subscribe` calls accept the new token. Only a 4008 close means the grant is gone.
 */
export function refreshingToken(opts: RefreshingTokenOptions): RefreshingToken {
  const now = opts.now ?? Date.now;
  const aheadMs = (opts.refreshAheadSeconds ?? 60) * 1000;
  let current: StoredTokens | null | undefined;
  let inFlight: Promise<string> | null = null;
  let dead: ReauthorizeError | null = null;

  const load = async (): Promise<StoredTokens> => {
    if (current === undefined) current = await opts.store.load();
    if (!current) throw new ReauthorizeError("invalid_grant");
    return current;
  };

  const rotate = (): Promise<string> => {
    if (dead) return Promise.reject(dead);
    inFlight ??= (async () => {
      try {
        const old = await load();
        let next: TokenSet;
        try {
          next = await refresh({ ...opts, refreshToken: old.refreshToken });
        } catch (err) {
          if (err instanceof OAuthError && err.code === "invalid_grant") {
            dead = new ReauthorizeError("invalid_grant", { cause: err });
            throw dead;
          }
          throw err;
        }
        const stored: StoredTokens = {
          accessToken: next.accessToken,
          // The server always rotates; keep the old one only if a server ever stops sending it.
          refreshToken: next.refreshToken ?? old.refreshToken,
          expiresAt: next.expiresAt,
          scopes: next.scopes,
        };
        // Keep the new pair in memory even if saving fails: the old refresh token is spent, and
        // presenting it again would revoke the whole grant (reuse detection).
        current = stored;
        await opts.store.save(stored);
        return stored.accessToken;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const getToken = async (): Promise<string> => {
    if (dead) throw dead;
    if (inFlight) return inFlight;
    const t = await load();
    if (t.expiresAt - aheadMs > now()) return t.accessToken;
    return rotate();
  };
  return Object.assign(getToken, { refresh: rotate });
}
