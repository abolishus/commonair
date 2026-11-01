// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OAuth side of the import (ADR 0031 decisions 2 and 4): the authorize URL with **no scopes**,
 * the code exchange, the token validation and the revocation. Every call goes to
 * `TWITCH_AUTH_BASE_URL` (fixed host, no redirects, a timeout). Tokens are returned to the caller
 * and never written into an error.
 */
import { z } from "zod";
import { type FetchOptions, fixedFetch, fixedUrl, HelixError } from "./helix.ts";

export interface AuthorizeInput {
  /** `TWITCH_AUTH_BASE_URL`, e.g. `https://id.twitch.tv/oauth2`. */
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
}

/**
 * The authorize URL. `scope` is present and empty: the authorization proves control of the account
 * and nothing more. `force_verify` makes Twitch ask again, so a shared browser cannot import the
 * last signed-in Twitch account by accident.
 */
export function authorizeUrl(input: AuthorizeInput): string {
  return fixedUrl(input.authBaseUrl, "authorize", {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "",
    state: input.state,
    force_verify: "true",
  }).toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().max(32).optional(),
  scope: z.array(z.string().max(100)).max(100).nullish(),
});

const ValidateResponse = z.object({
  client_id: z.string().max(200),
  login: z.string().max(64).nullish(),
  user_id: z.string().max(64).nullish(),
  scopes: z.array(z.string().max(100)).max(100).nullish(),
});

export interface ValidatedToken {
  clientId: string;
  login: string | null;
  userId: string | null;
  scopes: string[];
}

interface Common extends FetchOptions {
  authBaseUrl: string;
}

const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

/** Exchange the authorization code for a user access token. */
export async function exchangeCode(
  input: Common & { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<{ accessToken: string; scopes: string[] }> {
  const res = await fixedFetch(
    fixedUrl(input.authBaseUrl, "token"),
    {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      }),
    },
    input,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HelixError("http", res.status, `token answered ${res.status}`);
  }
  const parsed = TokenResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new HelixError("malformed", res.status, "token: malformed response");
  return { accessToken: parsed.data.access_token, scopes: parsed.data.scope ?? [] };
}

/** `GET /validate`: which app and user the token belongs to, and its scopes. */
export async function validateToken(input: Common & { token: string }): Promise<ValidatedToken> {
  const res = await fixedFetch(
    fixedUrl(input.authBaseUrl, "validate"),
    { method: "GET", headers: { authorization: `OAuth ${input.token}`, accept: "application/json" } },
    input,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HelixError("http", res.status, `validate answered ${res.status}`);
  }
  const parsed = ValidateResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new HelixError("malformed", res.status, "validate: malformed response");
  return {
    clientId: parsed.data.client_id,
    login: parsed.data.login ?? null,
    userId: parsed.data.user_id ?? null,
    scopes: parsed.data.scopes ?? [],
  };
}

/** Revoke the token. True when Twitch confirmed it (200); never throws on an answer, only on transport. */
export async function revokeToken(input: Common & { clientId: string; token: string }): Promise<boolean> {
  const res = await fixedFetch(
    fixedUrl(input.authBaseUrl, "revoke"),
    { method: "POST", headers: FORM, body: new URLSearchParams({ client_id: input.clientId, token: input.token }) },
    input,
  );
  await res.body?.cancel().catch(() => {});
  return res.ok;
}
