// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OAuth 2.1 for third-party apps (ADR 0027 §1-2): authorization code + PKCE (S256 only) for every
 * client, refresh-token rotation with reuse detection, client credentials (no scopes), and the
 * RFC 8628 device flow. Machine endpoints are raw form-encoded handlers on the API, Twitch-shaped
 * under `/api/oauth2/*`; the consent and activation pages are web routes.
 */
import { z } from "zod";
import { SCOPE_NAMES, type Scope } from "./scopes.ts";

export const OAUTH_PATHS = {
  /** RFC 6749 §3.2 token endpoint (all grants). */
  token: "/api/oauth2/token",
  /** RFC 7009 revocation (access or refresh token; a refresh token revokes its family). */
  revoke: "/api/oauth2/revoke",
  /** RFC 8628 §3.1 device authorization endpoint. */
  device: "/api/oauth2/device",
  /** Twitch-shaped `GET` (`developer.tokens.validate`, an oRPC procedure). */
  validate: "/api/oauth2/validate",
  /** Web: the consent page apps send the browser to. */
  authorizePage: "/oauth2/authorize",
  /** Web: where a user types a device's user code (RFC 8628 `verification_uri`). */
  activatePage: "/activate",
} as const;

/** `/signin?returnTo=`: same rule as `ReturnPath`, long enough for an OAuth consent URL. */
export const SignInReturnPath = z
  .string()
  .max(4096)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a relative path starting with a single /");

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const OAUTH_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
  DEVICE_CODE_GRANT,
] as const;

/** Lifetimes and limits. Tests move the API's clock (`deps.now`) rather than these. */
export const OAUTH_LIMITS = {
  codeTtlSeconds: 60,
  accessTokenTtlSeconds: 4 * 3600,
  /** A refresh token is good for this long after it is issued; rotation issues a fresh one. */
  refreshTokenTtlSeconds: 30 * 86_400,
  clientCredentialsTtlSeconds: 24 * 3600,
  deviceCodeTtlSeconds: 600,
  devicePollIntervalSeconds: 5,
  /** RFC 8628 §3.5: each `slow_down` adds this to the device code's interval. */
  deviceSlowDownSeconds: 5,
  stateMaxLength: 500,
  appsPerUser: 25,
  redirectUrisPerApp: 10,
} as const;

/** RFC 8628 §6.1: 8 characters from 20 consonants (no vowels, no look-alikes), shown as XXXX-XXXX. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const normalizeUserCode = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, "");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function parseUrl(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/**
 * Redirect URIs (OAuth 2.1 §2.3.1, RFC 8252): `https:`; `http:` only on a loopback host
 * (127.0.0.1, [::1], localhost), where any port matches at authorize time; or a private-use
 * scheme with a dot (`com.example.app:/cb`). No fragment, no userinfo.
 */
export function redirectUriProblem(uri: string): string | null {
  const url = parseUrl(uri);
  if (!url) return "not an absolute URI";
  // `URL` drops an empty fragment ("…#"), so look at the raw string too.
  if (uri.includes("#")) return "a fragment is not allowed";
  if (url.username !== "" || url.password !== "") return "userinfo is not allowed";
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return url.hostname === "" ? "https needs a host" : null;
  if (scheme === "http") return LOOPBACK_HOSTS.has(url.hostname) ? null : "http is allowed on a loopback host only";
  if (!scheme.includes(".")) return "a private-use scheme must contain a dot (reverse domain name)";
  return null;
}
export const RedirectUri = z
  .string()
  .max(2000)
  .refine((u) => redirectUriProblem(u) === null, { message: "not an allowed redirect URI" });

/** Exact match, except a loopback `http:` URI matches on scheme, host and path with any port. */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const a = parseUrl(registered);
  const b = parseUrl(presented);
  if (!a || !b) return false;
  if (a.protocol !== "http:" || b.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(a.hostname) || a.hostname !== b.hostname) return false;
  // RFC 8252 §7.3: native apps bind an ephemeral port, so only the port may differ.
  a.port = "";
  b.port = "";
  return a.href === b.href && !presented.includes("#");
}

/** RFC 7636 §4.2 S256: base64url(sha256(ascii(verifier))), no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Space-separated scope string → known scopes, or the unknown names. */
export function parseScope(scope: string): { ok: true; scopes: Scope[] } | { ok: false; unknown: string[] } {
  const known = new Set<string>(SCOPE_NAMES);
  const names = [...new Set(scope.split(" ").filter((s) => s !== ""))];
  const unknown = names.filter((s) => !known.has(s));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, scopes: names as Scope[] };
}

export const OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "temporarily_unavailable",
] as const;
export const OAuthErrorResponse = z.object({
  error: z.enum(OAUTH_ERROR_CODES),
  error_description: z.string().optional(),
});

/** RFC 6749 §5.1. `scope` is the RFC's space-separated string (not Twitch's array; the SDK parses it). */
export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("bearer"),
  expires_in: z.number().int(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** RFC 8628 §3.2. */
export const DeviceAuthorizationResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});

/** Token request fields as they arrive (form body or query; the body wins). Strings only. */
export const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().max(200),
    redirect_uri: z.string().max(2000),
    client_id: z.string().max(64),
    code_verifier: z.string().regex(PKCE_VERIFIER),
    client_secret: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(200),
    client_id: z.string().max(64),
    client_secret: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal("client_credentials"),
    client_id: z.string().max(64),
    client_secret: z.string().max(200),
    scope: z.literal("").optional(),
  }),
  z.object({
    grant_type: z.literal(DEVICE_CODE_GRANT),
    device_code: z.string().max(200),
    client_id: z.string().max(64),
    client_secret: z.string().max(200).optional(),
  }),
]);
export const RevokeRequest = z.object({
  token: z.string().max(200),
  client_id: z.string().max(64),
  client_secret: z.string().max(200).optional(),
  token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
});
export const DeviceAuthorizationRequest = z.object({
  client_id: z.string().max(64),
  scope: z.string().max(2000).default(""),
});

export { SCOPE_NAMES };
