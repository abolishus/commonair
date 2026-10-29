// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DEVICE_CODE_GRANT,
  OAUTH_PATHS,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  pkceChallenge,
} from "@commonair/contracts/oauth";
import { describe, expect, test } from "vite-plus/test";
import {
  OAuthError,
  ReauthorizeError,
  authorizeUrl,
  clientCredentials,
  createPkcePair,
  deviceFlow,
  exchangeCode,
  memoryStore,
  refresh,
  refreshingToken,
  revoke,
  type StoredTokens,
} from "../src/index.ts";
import { fakeFetch, oauthError, tokenJson } from "./fake-fetch.ts";

const BASE = "https://api.example.test/";

describe("PKCE", () => {
  test("RFC 7636 appendix B vector through pkceChallenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("createPkcePair: 64 unreserved characters, S256 challenge, fresh every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = await createPkcePair();
      expect(p.verifier).toHaveLength(64);
      expect(p.verifier).toMatch(PKCE_VERIFIER);
      expect(p.challenge).toMatch(PKCE_CHALLENGE);
      expect(p.challenge).toBe(await pkceChallenge(p.verifier));
      expect(p.method).toBe("S256");
      seen.add(p.verifier);
    }
    expect(seen.size).toBe(50);
  });

  test("every unreserved symbol can appear (no alphabet truncation)", async () => {
    const chars = new Set<string>();
    for (let i = 0; i < 200; i++) for (const c of (await createPkcePair()).verifier) chars.add(c);
    expect(chars.size).toBe(66);
  });
});

describe("authorizeUrl", () => {
  test("encodes every parameter on the consent page path", () => {
    const u = new URL(
      authorizeUrl({
        baseUrl: BASE,
        clientId: "cid_1",
        redirectUri: "http://127.0.0.1:8080/cb?x=1&y=2",
        scopes: ["chat:read", "channel:read:subscriptions"],
        state: "a b&c=d",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      }),
    );
    expect(u.origin + u.pathname).toBe(`https://api.example.test${OAUTH_PATHS.authorizePage}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid_1",
      redirect_uri: "http://127.0.0.1:8080/cb?x=1&y=2",
      response_type: "code",
      scope: "chat:read channel:read:subscriptions",
      state: "a b&c=d",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    // Reserved characters never reach the query unescaped.
    expect(u.search).not.toContain("&y=2");
    expect(u.search).toContain("state=a+b%26c%3Dd");
  });

  test("forceVerify adds force_verify=true; empty scopes stay an empty scope", () => {
    const u = new URL(
      authorizeUrl({
        baseUrl: "https://x.test",
        clientId: "c",
        redirectUri: "https://app.test/cb",
        scopes: [],
        state: "s",
        codeChallenge: "c".repeat(43),
        forceVerify: true,
      }),
    );
    expect(u.searchParams.get("force_verify")).toBe("true");
    expect(u.searchParams.get("scope")).toBe("");
  });
});

describe("token endpoint", () => {
  test("exchangeCode posts a form with client_secret_post and parses the token", async () => {
    const f = fakeFetch([{ json: tokenJson(1) }]);
    const t = await exchangeCode({
      baseUrl: BASE,
      clientId: "cid",
      clientSecret: "secret",
      code: "code1",
      redirectUri: "https://app.test/cb",
      codeVerifier: "v".repeat(64),
      fetch: f.fetch,
      now: () => 1_000,
    });
    expect(t).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAt: 1_000 + 3_600_000,
      scopes: ["chat:read", "chat:edit"],
    });
    const r = f.requests[0];
    expect(r?.url).toBe(`https://api.example.test${OAUTH_PATHS.token}`);
    expect(r?.method).toBe("POST");
    expect(r?.contentType).toBe("application/x-www-form-urlencoded");
    expect(r?.form).toEqual({
      grant_type: "authorization_code",
      code: "code1",
      redirect_uri: "https://app.test/cb",
      code_verifier: "v".repeat(64),
      client_id: "cid",
      client_secret: "secret",
    });
  });

  test("public clients send no secret", async () => {
    const f = fakeFetch([{ json: tokenJson(2) }]);
    await refresh({ baseUrl: BASE, clientId: "pub", refreshToken: "rt_1", fetch: f.fetch });
    expect(f.requests[0]?.form).toEqual({ grant_type: "refresh_token", refresh_token: "rt_1", client_id: "pub" });
  });

  test("clientCredentials: no refresh token, empty scopes", async () => {
    const f = fakeFetch([{ json: tokenJson(3, { refresh_token: undefined, scope: "" }) }]);
    const t = await clientCredentials({ baseUrl: BASE, clientId: "c", clientSecret: "s", fetch: f.fetch });
    expect(t.refreshToken).toBeNull();
    expect(t.scopes).toEqual([]);
    expect(f.requests[0]?.form).toEqual({ grant_type: "client_credentials", client_id: "c", client_secret: "s" });
  });

  test("refusals throw OAuthError with the RFC code and status", async () => {
    const f = fakeFetch([oauthError("invalid_grant"), oauthError("invalid_client", 401)]);
    const err = await refresh({ baseUrl: BASE, clientId: "c", refreshToken: "old", fetch: f.fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).status).toBe(400);
    const err2 = await clientCredentials({ baseUrl: BASE, clientId: "c", clientSecret: "bad", fetch: f.fetch }).catch(
      (e: unknown) => e,
    );
    expect((err2 as OAuthError).code).toBe("invalid_client");
    expect((err2 as OAuthError).status).toBe(401);
  });

  test("non-OAuth answers are invalid_response, never a token", async () => {
    const f = fakeFetch([{ status: 502, text: "<html>bad gateway</html>" }, { json: { access_token: 1 } }]);
    const a = await refresh({ baseUrl: BASE, clientId: "c", refreshToken: "r", fetch: f.fetch }).catch(
      (e: unknown) => e,
    );
    expect((a as OAuthError).code).toBe("invalid_response");
    expect((a as OAuthError).status).toBe(502);
    const b = await refresh({ baseUrl: BASE, clientId: "c", refreshToken: "r", fetch: f.fetch }).catch(
      (e: unknown) => e,
    );
    expect((b as OAuthError).code).toBe("invalid_response");
  });

  test("revoke posts the token and its hint; refusals throw", async () => {
    const f = fakeFetch([{ status: 200 }, oauthError("invalid_client", 401)]);
    await revoke({
      baseUrl: BASE,
      clientId: "c",
      clientSecret: "s",
      token: "rt_9",
      tokenTypeHint: "refresh_token",
      fetch: f.fetch,
    });
    expect(f.requests[0]?.url).toBe(`https://api.example.test${OAUTH_PATHS.revoke}`);
    expect(f.requests[0]?.form).toEqual({
      token: "rt_9",
      token_type_hint: "refresh_token",
      client_id: "c",
      client_secret: "s",
    });
    await expect(revoke({ baseUrl: BASE, clientId: "c", token: "x", fetch: f.fetch })).rejects.toThrow(OAuthError);
  });
});

const deviceStart = (interval = 5, expiresIn = 600) => ({
  json: {
    device_code: "dc_1",
    user_code: "BCDF-GHJK",
    verification_uri: "https://x.test/activate",
    verification_uri_complete: "https://x.test/activate?code=BCDFGHJK",
    expires_in: expiresIn,
    interval,
  },
});

describe("deviceFlow", () => {
  test("pending → slow_down (+5 s) → pending → token", async () => {
    const f = fakeFetch([
      deviceStart(5),
      oauthError("authorization_pending"),
      oauthError("slow_down"),
      oauthError("authorization_pending"),
      { json: tokenJson(7) },
    ]);
    const waits: number[] = [];
    const codes: string[] = [];
    const t = await deviceFlow({
      baseUrl: BASE,
      clientId: "pub",
      scopes: ["chat:read", "chat:edit"],
      onCode: (c) => void codes.push(`${c.userCode} ${c.verificationUriComplete}`),
      fetch: f.fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(t.accessToken).toBe("at_7");
    expect(codes).toEqual(["BCDF-GHJK https://x.test/activate?code=BCDFGHJK"]);
    expect(waits).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(f.requests[0]?.url).toBe(`https://api.example.test${OAUTH_PATHS.device}`);
    expect(f.requests[0]?.form).toEqual({ scope: "chat:read chat:edit", client_id: "pub" });
    expect(f.requests[1]?.form).toEqual({ grant_type: DEVICE_CODE_GRANT, device_code: "dc_1", client_id: "pub" });
  });

  test("access_denied and expired_token stop the flow", async () => {
    for (const code of ["access_denied", "expired_token"] as const) {
      const f = fakeFetch([deviceStart(1), oauthError("authorization_pending"), oauthError(code)]);
      const err = await deviceFlow({
        baseUrl: BASE,
        clientId: "pub",
        scopes: [],
        onCode: () => undefined,
        fetch: f.fetch,
        sleep: async () => undefined,
      }).catch((e: unknown) => e);
      expect((err as OAuthError).code).toBe(code);
      expect(f.remaining()).toBe(0);
    }
  });

  test("the device code running out on the client is expired_token", async () => {
    let now = 0;
    const f = fakeFetch([deviceStart(5, 10), oauthError("authorization_pending"), oauthError("authorization_pending")]);
    const err = await deviceFlow({
      baseUrl: BASE,
      clientId: "pub",
      scopes: [],
      onCode: () => undefined,
      fetch: f.fetch,
      now: () => now,
      sleep: async (ms) => void (now += ms),
    }).catch((e: unknown) => e);
    expect((err as OAuthError).code).toBe("expired_token");
    expect((err as OAuthError).status).toBe(0);
  });

  test("abort stops polling with the abort reason (real sleep)", async () => {
    const f = fakeFetch([deviceStart(1), oauthError("authorization_pending"), oauthError("authorization_pending")]);
    const ac = new AbortController();
    const started = Date.now();
    const p = deviceFlow({
      baseUrl: BASE,
      clientId: "pub",
      scopes: [],
      onCode: () => void setTimeout(() => ac.abort(new Error("user gave up")), 50),
      fetch: f.fetch,
      signal: ac.signal,
    });
    await expect(p).rejects.toThrow("user gave up");
    expect(Date.now() - started).toBeLessThan(900);
    expect(f.requests).toHaveLength(1);
  });

  test("a refused device request throws before onCode", async () => {
    const f = fakeFetch([oauthError("invalid_scope")]);
    let called = false;
    const err = await deviceFlow({
      baseUrl: BASE,
      clientId: "pub",
      scopes: ["nope"],
      onCode: () => void (called = true),
      fetch: f.fetch,
    }).catch((e: unknown) => e);
    expect((err as OAuthError).code).toBe("invalid_scope");
    expect(called).toBe(false);
  });
});

describe("refreshingToken", () => {
  const stored = (n: number, expiresAt: number): StoredTokens => ({
    accessToken: `at_${n}`,
    refreshToken: `rt_${n}`,
    expiresAt,
  });

  test("returns the stored token until it is within refreshAhead of expiry, then rotates and saves", async () => {
    let now = 0;
    const saved: StoredTokens[] = [];
    const f = fakeFetch([{ json: tokenJson(2) }]);
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      clientSecret: "s",
      store: memoryStore(stored(1, 120_000), (t) => saved.push(t)),
      refreshAheadSeconds: 60,
      fetch: f.fetch,
      now: () => now,
    });
    expect(await getToken()).toBe("at_1");
    now = 59_000;
    expect(await getToken()).toBe("at_1");
    now = 60_000;
    expect(await getToken()).toBe("at_2");
    expect(saved).toEqual([
      { accessToken: "at_2", refreshToken: "rt_2", expiresAt: 60_000 + 3_600_000, scopes: ["chat:read", "chat:edit"] },
    ]);
    expect(f.requests[0]?.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt_1" });
    expect(await getToken()).toBe("at_2");
    expect(f.requests).toHaveLength(1);
  });

  test("single flight: concurrent callers share one refresh; the next rotation uses the new refresh token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 1;
    const f = fakeFetch([() => ({ json: tokenJson(++n) }), () => ({ json: tokenJson(++n) })]);
    const slow = async (r: Request) => {
      await gate;
      return f.fetch(r);
    };
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      store: memoryStore(stored(1, 0)),
      fetch: slow,
      now: () => 1,
    });
    const all = Promise.all([getToken(), getToken(), getToken(), getToken.refresh()]);
    release();
    expect(await all).toEqual(["at_2", "at_2", "at_2", "at_2"]);
    expect(f.requests).toHaveLength(1);
    expect(await getToken.refresh()).toBe("at_3");
    expect(f.requests[1]?.form.refresh_token).toBe("rt_2");
  });

  test("invalid_grant surfaces ReauthorizeError and never retries the old refresh token", async () => {
    const f = fakeFetch([oauthError("invalid_grant")]);
    const saved: StoredTokens[] = [];
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      store: memoryStore(stored(1, 0), (t) => saved.push(t)),
      fetch: f.fetch,
    });
    const err = await getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthorizeError);
    expect((err as ReauthorizeError).reason).toBe("invalid_grant");
    await expect(getToken()).rejects.toBeInstanceOf(ReauthorizeError);
    await expect(getToken.refresh()).rejects.toBeInstanceOf(ReauthorizeError);
    expect(f.requests).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  test("a transient failure is retried on the next call (the refresh token was not consumed)", async () => {
    const f = fakeFetch([oauthError("temporarily_unavailable", 503), { json: tokenJson(2) }]);
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      store: memoryStore(stored(1, 0)),
      fetch: f.fetch,
    });
    await expect(getToken()).rejects.toThrow(OAuthError);
    expect(await getToken()).toBe("at_2");
    expect(f.requests.map((r) => r.form.refresh_token)).toEqual(["rt_1", "rt_1"]);
  });

  test("an empty store asks to re-authorize; an async store is loaded once", async () => {
    await expect(refreshingToken({ baseUrl: BASE, clientId: "c", store: memoryStore(null) })()).rejects.toBeInstanceOf(
      ReauthorizeError,
    );
    let loads = 0;
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      store: {
        load: async () => {
          loads++;
          return stored(5, Number.MAX_SAFE_INTEGER);
        },
        save: async () => undefined,
      },
    });
    expect(await getToken()).toBe("at_5");
    expect(await getToken()).toBe("at_5");
    expect(loads).toBe(1);
  });

  test("a save failure is thrown, but the spent refresh token is never presented again", async () => {
    const f = fakeFetch([{ json: tokenJson(2) }, { json: tokenJson(3) }]);
    const getToken = refreshingToken({
      baseUrl: BASE,
      clientId: "c",
      store: {
        load: () => stored(1, 0),
        save: () => {
          throw new Error("disk full");
        },
      },
      fetch: f.fetch,
    });
    await expect(getToken()).rejects.toThrow("disk full");
    await expect(getToken.refresh()).rejects.toThrow("disk full");
    expect(f.requests.map((r) => r.form.refresh_token)).toEqual(["rt_1", "rt_2"]);
  });
});
