// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer-platform` step 2's pure helpers (harness/src/e9/oauth.ts): PKCE pairs and redirect parsing. */
import { describe, expect, test } from "vite-plus/test";
import { pkceChallenge } from "@commonair/contracts/oauth";
import { isPkcePair, newPkcePair, parseRedirect, STEP2_SCOPES, step } from "../../src/e9/oauth.ts";

describe("newPkcePair", () => {
  test("a valid RFC 7636 verifier and its S256 challenge, fresh each time", async () => {
    const a = await newPkcePair();
    const b = await newPkcePair();
    expect(isPkcePair(a)).toBe(true);
    expect(a.verifier).toHaveLength(64);
    expect(a.challenge).toBe(await pkceChallenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
  });

  test("isPkcePair rejects a short verifier or a padded challenge", () => {
    expect(isPkcePair({ verifier: "short", challenge: "x".repeat(43) })).toBe(false);
    expect(isPkcePair({ verifier: "v".repeat(43), challenge: `${"x".repeat(42)}=` })).toBe(false);
  });
});

describe("parseRedirect", () => {
  const expected = { redirectUri: "http://127.0.0.1:4567/cb", state: "s 1/é" };
  const back = (params: Record<string, string>, base = expected.redirectUri) => {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
    return u.href;
  };

  test("a code with the state", () => {
    expect(parseRedirect(back({ code: "cac_1", state: expected.state }), expected)).toEqual({
      kind: "code",
      code: "cac_1",
    });
  });

  test("an error with the state", () => {
    expect(parseRedirect(back({ error: "access_denied", state: expected.state }), expected)).toEqual({
      kind: "error",
      error: "access_denied",
    });
  });

  test("a missing or different state, another target, or nothing at all throws", () => {
    expect(() => parseRedirect(back({ code: "c" }), expected)).toThrow(/state/);
    expect(() => parseRedirect(back({ code: "c", state: "other" }), expected)).toThrow(/state/);
    expect(() =>
      parseRedirect(back({ code: "c", state: expected.state }, "http://127.0.0.1:4567/other"), expected),
    ).toThrow(/redirect URI/);
    expect(() => parseRedirect(back({ state: expected.state }), expected)).toThrow(/neither/);
  });
});

describe("step 2 module", () => {
  test("ready, needs step 1, and asks for step 5's poll and points scopes", () => {
    expect(step).toMatchObject({ name: "oauth", owner: "E9-oauth", ready: true, needs: [1] });
    expect(STEP2_SCOPES).toEqual(
      expect.arrayContaining([
        "chat:read",
        "channel:read:subscriptions",
        "channel:manage:polls",
        "channel:read:points",
      ]),
    );
  });
});
