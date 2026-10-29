// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E9-oauth pure protocol helpers (RFC 6749 §2.3.1, §3.1; RFC 8628 §6.1): parameter merging,
 * client credential extraction, user-code generation and redirect URLs.
 */
import { describe, expect, test } from "vite-plus/test";
import { USER_CODE_ALPHABET, normalizeUserCode } from "@commonair/contracts/oauth";
import {
  OAuthError,
  USER_CODE_BYTE_LIMIT,
  buildRedirect,
  clientCredentials,
  formatUserCode,
  generateUserCode,
  oauthErrorResponse,
  readParams,
} from "../src/oauth/protocol.ts";

const URL_BASE = "http://api.test/api/oauth2/token";
const form = (body: string, query = "", headers: Record<string, string> = {}) =>
  new Request(`${URL_BASE}${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });

async function oauthCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof OAuthError) return err.code;
    throw err;
  }
  throw new Error("expected an OAuthError");
}

describe("readParams", () => {
  test("reads the form body", async () => {
    expect(await readParams(form("grant_type=refresh_token&refresh_token=car_x"))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "car_x",
    });
  });

  test("falls back to the query string, and the body wins where both carry a parameter", async () => {
    const req = form("client_id=body", "?client_id=query&grant_type=client_credentials");
    expect(await readParams(req)).toEqual({ client_id: "body", grant_type: "client_credentials" });
    expect(await readParams(new Request(`${URL_BASE}?a=1`, { method: "POST" }))).toEqual({ a: "1" });
  });

  test("ignores a body that is not form-encoded", async () => {
    const req = new Request(`${URL_BASE}?a=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ b: 2 }),
    });
    expect(await readParams(req)).toEqual({ a: "1" });
  });

  test("accepts a charset on the content type and decodes form escapes", async () => {
    const req = new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "scope=chat%3Aread+chat%3Aedit&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb",
    });
    expect(await readParams(req)).toEqual({ scope: "chat:read chat:edit", redirect_uri: "http://127.0.0.1:5/cb" });
  });

  test("empty values count as absent", async () => {
    expect(await readParams(form("scope=&a=1"))).toEqual({ a: "1" });
  });

  test("a repeated parameter is invalid_request", async () => {
    expect(await oauthCode(() => readParams(form("a=1&a=2")))).toBe("invalid_request");
    expect(await oauthCode(() => readParams(form("", "?a=1&a=2")))).toBe("invalid_request");
  });

  test("an oversized body is invalid_request", async () => {
    expect(await oauthCode(() => readParams(form(`a=${"x".repeat(17_000)}`)))).toBe("invalid_request");
  });
});

const basic = (id: string, secret: string) =>
  new Headers({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` });

describe("clientCredentials", () => {
  test("client_secret_basic, each half form-decoded (RFC 6749 §2.3.1)", () => {
    const id = "id with:colon";
    const secret = "s+cret/ü%";
    const headers = basic(encodeURIComponent(id), encodeURIComponent(secret));
    expect(clientCredentials(headers, {})).toEqual({ clientId: id, secret, method: "basic" });
    // `+` is a space in form encoding.
    expect(clientCredentials(basic("a+b", "c+d"), {})).toEqual({ clientId: "a b", secret: "c d", method: "basic" });
  });

  test("the secret may contain a colon; the first one splits", () => {
    expect(clientCredentials(basic("cid", "a:b"), {})).toMatchObject({ clientId: "cid", secret: "a:b" });
  });

  test("Basic with a matching client_id parameter is fine; a different one is invalid_request", async () => {
    expect(clientCredentials(basic("cid", "s"), { client_id: "cid" }).clientId).toBe("cid");
    expect(await oauthCode(() => clientCredentials(basic("cid", "s"), { client_id: "other" }))).toBe("invalid_request");
  });

  test("client_secret_post and a public client's bare client_id", () => {
    expect(clientCredentials(new Headers(), { client_id: "cid", client_secret: "s" })).toEqual({
      clientId: "cid",
      secret: "s",
      method: "post",
    });
    expect(clientCredentials(new Headers(), { client_id: "cid" })).toEqual({
      clientId: "cid",
      secret: null,
      method: "none",
    });
  });

  test("both methods at once is invalid_request", async () => {
    expect(await oauthCode(() => clientCredentials(basic("cid", "s"), { client_secret: "s" }))).toBe("invalid_request");
  });

  test("no client at all is invalid_request; a malformed Basic header is invalid_client with a challenge", async () => {
    expect(await oauthCode(() => clientCredentials(new Headers(), {}))).toBe("invalid_request");
    const bad = new Headers({ authorization: `Basic ${Buffer.from("nocolon").toString("base64")}` });
    let caught: unknown = null;
    try {
      clientCredentials(bad, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    const res = oauthErrorResponse(caught as OAuthError);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(await oauthCode(() => clientCredentials(new Headers({ authorization: "Bearer x" }), {}))).toBe(
      "invalid_client",
    );
  });
});

describe("oauthErrorResponse", () => {
  test("RFC body, no-store, 400 by default and 401 for invalid_client", async () => {
    const res = oauthErrorResponse(new OAuthError("invalid_grant", "nope"));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "nope" });
    expect(oauthErrorResponse(new OAuthError("invalid_client", "x")).status).toBe(401);
    expect(oauthErrorResponse(new OAuthError("invalid_client", "x")).headers.get("www-authenticate")).toBeNull();
  });
});

describe("user codes", () => {
  test("8 characters from the alphabet; formatted XXXX-XXXX and normalized back", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      expect(code).toMatch(new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`));
      expect(normalizeUserCode(formatUserCode(code).toLowerCase())).toBe(code);
    }
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  test("no modulo bias: bytes at or above the largest multiple of 20 are rejected", () => {
    expect(USER_CODE_BYTE_LIMIT).toBe(240);
    // Every accepted byte value maps to each letter exactly 12 times, by construction.
    const counts = new Map<string, number>();
    for (let b = 0; b < USER_CODE_BYTE_LIMIT; b++) {
      const c = USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]!;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(new Set(counts.values())).toEqual(new Set([USER_CODE_BYTE_LIMIT / USER_CODE_ALPHABET.length]));
    // A source that only yields rejected bytes first, then 0..: the rejected ones never show up.
    let calls = 0;
    const code = generateUserCode((n) => {
      calls++;
      return calls === 1 ? new Uint8Array(n).fill(255) : Uint8Array.from({ length: n }, (_, i) => i);
    });
    expect(code).toBe(USER_CODE_ALPHABET.slice(0, 8));
    expect(calls).toBe(2);
  });

  test("a large sample is close to uniform", () => {
    const counts = new Map<string, number>();
    const n = 20_000;
    for (let i = 0; i < n / 8; i++) for (const c of generateUserCode()) counts.set(c, (counts.get(c) ?? 0) + 1);
    const expected = n / USER_CODE_ALPHABET.length;
    for (const c of USER_CODE_ALPHABET) expect(Math.abs((counts.get(c) ?? 0) - expected)).toBeLessThan(expected * 0.15);
  });
});

describe("buildRedirect", () => {
  test("keeps the registered query and appends code and state, encoded", () => {
    const url = buildRedirect("https://app.example.test/cb?tenant=a%20b&x=1", { code: "cac_1", state: "s &=#?/é" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://app.example.test/cb");
    expect(parsed.searchParams.get("tenant")).toBe("a b");
    expect(parsed.searchParams.get("x")).toBe("1");
    expect(parsed.searchParams.get("code")).toBe("cac_1");
    expect(parsed.searchParams.get("state")).toBe("s &=#?/é");
    expect(parsed.hash).toBe("");
  });

  test("omits undefined values (no state)", () => {
    const url = new URL(buildRedirect("http://127.0.0.1:4567/cb", { error: "access_denied", state: undefined }));
    expect([...url.searchParams.keys()]).toEqual(["error"]);
    expect(url.port).toBe("4567");
  });

  test("works for a private-use scheme", () => {
    const url = buildRedirect("com.example.app:/oauth/cb", { code: "c", state: "x" });
    expect(url).toBe("com.example.app:/oauth/cb?code=c&state=x");
  });
});
