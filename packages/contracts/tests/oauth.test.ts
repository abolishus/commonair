// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  DEVICE_CODE_GRANT,
  OAUTH_PATHS,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  RedirectUri,
  TokenRequest,
  USER_CODE_ALPHABET,
  normalizeUserCode,
  parseScope,
  pkceChallenge,
  redirectUriMatches,
  redirectUriProblem,
} from "../src/oauth.ts";

describe("redirectUriProblem", () => {
  test("https is allowed", () => {
    expect(redirectUriProblem("https://app.example.com/cb")).toBeNull();
    expect(redirectUriProblem("https://app.example.com/cb?x=1")).toBeNull();
    expect(RedirectUri.safeParse("https://app.example.com/cb").success).toBe(true);
  });
  test("http only on a loopback host, any port", () => {
    expect(redirectUriProblem("http://app.example.com/cb")).not.toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/cb")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1:53111/cb")).toBeNull();
    expect(redirectUriProblem("http://[::1]:8080/cb")).toBeNull();
    expect(redirectUriProblem("http://localhost:3000/cb")).toBeNull();
    expect(redirectUriProblem("http://192.168.1.10/cb")).not.toBeNull();
  });
  test("a private-use scheme needs a dot", () => {
    expect(redirectUriProblem("com.example.app:/cb")).toBeNull();
    expect(redirectUriProblem("myapp:/cb")).not.toBeNull();
    expect(redirectUriProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectUriProblem("data:text/html,x")).not.toBeNull();
  });
  test("fragments, userinfo and relative URIs are refused", () => {
    expect(redirectUriProblem("https://app.example.com/cb#x")).not.toBeNull();
    expect(redirectUriProblem("https://app.example.com/cb#")).not.toBeNull();
    expect(redirectUriProblem("https://user:pw@app.example.com/cb")).not.toBeNull();
    expect(redirectUriProblem("/cb")).not.toBeNull();
    expect(redirectUriProblem("")).not.toBeNull();
    expect(RedirectUri.safeParse("http://evil.example/cb").success).toBe(false);
  });
});

describe("redirectUriMatches", () => {
  test("exact match", () => {
    expect(redirectUriMatches("https://a.example/cb", "https://a.example/cb")).toBe(true);
  });
  test("a trailing slash or a different query does not match", () => {
    expect(redirectUriMatches("https://a.example/cb", "https://a.example/cb/")).toBe(false);
    expect(redirectUriMatches("https://a.example/cb?x=1", "https://a.example/cb?x=2")).toBe(false);
    expect(redirectUriMatches("https://a.example/cb", "https://a.example/cb?x=1")).toBe(false);
  });
  test("https ports are exact", () => {
    expect(redirectUriMatches("https://a.example/cb", "https://a.example:8443/cb")).toBe(false);
  });
  test("loopback http matches with any port, never another path or host", () => {
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:51234/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:1000/cb", "http://127.0.0.1:2000/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://localhost:51234/cb")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:51234/cb#x")).toBe(false);
  });
});

describe("PKCE", () => {
  test("S256 matches RFC 7636 Appendix B", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(PKCE_VERIFIER.test(verifier)).toBe(true);
    const challenge = await pkceChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(PKCE_CHALLENGE.test(challenge)).toBe(true);
  });
  test("verifier length bounds", () => {
    expect(PKCE_VERIFIER.test("a".repeat(42))).toBe(false);
    expect(PKCE_VERIFIER.test("a".repeat(43))).toBe(true);
    expect(PKCE_VERIFIER.test("a".repeat(128))).toBe(true);
    expect(PKCE_VERIFIER.test("a".repeat(129))).toBe(false);
  });
});

describe("parseScope", () => {
  test("known scopes, deduplicated, extra spaces ignored", () => {
    expect(parseScope("chat:read  chat:edit chat:read")).toEqual({ ok: true, scopes: ["chat:read", "chat:edit"] });
    expect(parseScope("")).toEqual({ ok: true, scopes: [] });
  });
  test("unknown names are reported", () => {
    expect(parseScope("chat:read nope:nope")).toEqual({ ok: false, unknown: ["nope:nope"] });
  });
});

describe("user codes", () => {
  test("normalize drops dashes and case", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDFGHJK");
  });
  test("the alphabet has 20 consonants and no vowels", () => {
    expect(new Set(USER_CODE_ALPHABET).size).toBe(20);
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOUY]/);
  });
});

describe("token requests", () => {
  test("parse by grant type", () => {
    expect(
      TokenRequest.safeParse({ grant_type: DEVICE_CODE_GRANT, device_code: "cad_x", client_id: "c" }).success,
    ).toBe(true);
    expect(TokenRequest.safeParse({ grant_type: "client_credentials", client_id: "c" }).success).toBe(false);
    expect(TokenRequest.safeParse({ grant_type: "password", client_id: "c" }).success).toBe(false);
  });
  test("machine endpoints live under /api/oauth2", () => {
    for (const p of [OAUTH_PATHS.token, OAUTH_PATHS.revoke, OAUTH_PATHS.device, OAUTH_PATHS.validate])
      expect(p.startsWith("/api/oauth2/")).toBe(true);
  });
});
