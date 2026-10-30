// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer-platform` step 3's pure helpers (harness/src/e9/consent.ts). */
import { SCOPE_NAMES } from "@commonair/contracts/scopes";
import { describe, expect, test } from "vite-plus/test";
import {
  STEP3_DEVICE_SCOPES,
  STEP3_SCOPES,
  authorizeUrl,
  callbackOutcome,
  coversScopes,
  isCallbackFor,
  isOnCallback,
  nextDeviceInterval,
  sameScopes,
  scopesOf,
  step,
} from "../../src/e9/consent.ts";
import type { ReceivedRequest } from "../../src/e9/receiver.ts";
import { STEP2_SCOPES } from "../../src/e9/oauth.ts";

const request = (over: Partial<ReceivedRequest> = {}): ReceivedRequest => ({
  method: "GET",
  path: "/cb",
  query: {},
  headers: {},
  body: "",
  receivedAt: 0,
  ...over,
});

describe("authorizeUrl", () => {
  const base = {
    clientId: "cid_1",
    redirectUri: "http://127.0.0.1:4567/cb",
    scopes: ["chat:read", "channel:read:points"] as const,
    state: "s 1/é&x=y",
    challenge: "c".repeat(43),
  };

  test("the consent page with the RFC 6749 names and PKCE S256", () => {
    const url = new URL(authorizeUrl("http://localhost:3000", base));
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid_1",
      redirect_uri: "http://127.0.0.1:4567/cb",
      response_type: "code",
      scope: "chat:read channel:read:points",
      state: "s 1/é&x=y",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    });
  });

  test("force_verify only when asked", () => {
    expect(new URL(authorizeUrl("http://w", { ...base, forceVerify: true })).searchParams.get("force_verify")).toBe(
      "true",
    );
    expect(new URL(authorizeUrl("http://w", base)).searchParams.has("force_verify")).toBe(false);
  });
});

describe("callbacks", () => {
  test("isCallbackFor matches GET /cb with that state only", () => {
    const match = isCallbackFor("abc");
    expect(match(request({ query: { state: "abc", code: "x" } }))).toBe(true);
    expect(match(request({ query: { state: "abd" } }))).toBe(false);
    expect(match(request({ path: "/hook", query: { state: "abc" } }))).toBe(false);
    expect(match(request({ method: "POST", query: { state: "abc" } }))).toBe(false);
    expect(match(request())).toBe(false);
  });

  test("isOnCallback: the page sits on the redirect URI with that state (before the next goto)", () => {
    const cb = "http://127.0.0.1:4567/cb";
    expect(isOnCallback(`${cb}?code=x&state=abc`, cb, "abc")).toBe(true);
    expect(isOnCallback(new URL(`${cb}?error=access_denied&state=abc`), cb, "abc")).toBe(true);
    expect(isOnCallback(`${cb}?code=x&state=abd`, cb, "abc")).toBe(false);
    expect(isOnCallback(`${cb}?code=x`, cb, "abc")).toBe(false);
    expect(isOnCallback("http://127.0.0.1:4568/cb?state=abc", cb, "abc")).toBe(false);
    expect(isOnCallback("http://localhost:3000/oauth2/authorize?state=abc", cb, "abc")).toBe(false);
  });

  test("callbackOutcome: an error wins, then a code, else empty", () => {
    expect(callbackOutcome({ query: { code: "cac_1", state: "s" } })).toEqual({ kind: "code", code: "cac_1" });
    expect(callbackOutcome({ query: { error: "access_denied", state: "s" } })).toEqual({
      kind: "error",
      error: "access_denied",
    });
    expect(callbackOutcome({ query: { error: "x", code: "y" } })).toEqual({ kind: "error", error: "x" });
    expect(callbackOutcome({ query: { state: "s" } })).toEqual({ kind: "empty" });
  });
});

describe("scopes", () => {
  test("scopesOf splits data-scopes", () => {
    expect(scopesOf("chat:read  clips:edit")).toEqual(["chat:read", "clips:edit"]);
    expect(scopesOf("")).toEqual([]);
    expect(scopesOf(null)).toEqual([]);
  });

  test("sameScopes: one row per scope, any order", () => {
    expect(sameScopes(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameScopes(["a", "a"], ["a"])).toBe(false);
    expect(sameScopes(["a"], ["a", "b"])).toBe(false);
    expect(sameScopes(["a", null], ["a", "b"])).toBe(false);
    expect(sameScopes([], [])).toBe(true);
  });

  test("coversScopes: every requested scope listed", () => {
    expect(coversScopes(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(coversScopes(["a"], ["a", "b"])).toBe(false);
    expect(coversScopes([], [])).toBe(true);
  });

  test("the step's scopes are real and match step 2's grant", () => {
    expect(STEP3_SCOPES).toEqual(STEP2_SCOPES);
    for (const s of [...STEP3_SCOPES, ...STEP3_DEVICE_SCOPES]) expect(SCOPE_NAMES).toContain(s);
  });
});

describe("device polling", () => {
  test("RFC 8628 §3.5: slow_down adds five seconds, anything else keeps the interval", () => {
    expect(nextDeviceInterval(5, "slow_down")).toBe(10);
    expect(nextDeviceInterval(5, "authorization_pending")).toBe(5);
    expect(nextDeviceInterval(7, null)).toBe(7);
  });
});

describe("step", () => {
  test("ready, web only, needs step 1's apps", () => {
    expect(step).toMatchObject({ name: "consent", owner: "E9-consent", ready: true, needs: [1], webOnly: true });
  });
});
