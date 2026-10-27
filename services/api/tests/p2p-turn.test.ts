// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** TURN REST credentials and the ICE server answer (ADR 0005 amendment 1, decision 2). */
import { describe, expect, test } from "vite-plus/test";
import {
  iceServersFor,
  TURN_ID_BYTES,
  TURN_ID_LABEL,
  turnCredentials,
  turnOpaqueId,
  turnPassword,
  TurnNotConfigured,
} from "../src/p2p/turn.ts";

const SECRET = "a-shared-secret-of-at-least-32-chars!";
const SID = "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";
const OTHER = "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6c";
const NOW = new Date("2026-10-27T12:00:00.400Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

/** HMAC through WebCrypto, independent of the node:crypto implementation under test. */
async function hmac(hash: "SHA-1" | "SHA-256", key: string | Uint8Array<ArrayBuffer>, data: string) {
  const raw = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

describe("TURN REST credentials", () => {
  test("the password is base64(HMAC-SHA1(secret, username)): a fixed vector (openssl dgst -sha1 -hmac)", () => {
    expect(turnPassword(SECRET, "1700003600:test")).toBe("MbdYNatkLs5SHgV1JbS0Hzbf9mE=");
  });

  test("the password matches an independently computed HMAC-SHA1", async () => {
    const { username, credential } = turnCredentials(SECRET, SID, 3600, NOW);
    expect(credential).toBe(Buffer.from(await hmac("SHA-1", SECRET, username)).toString("base64"));
  });

  test("username is <expiry epoch seconds>:<opaque id>, expiry from the injected clock plus the TTL", () => {
    const { username, expiresAt } = turnCredentials(SECRET, SID, 3600, NOW);
    const [expiry, id, ...rest] = username.split(":");
    expect(rest).toEqual([]);
    expect(Number(expiry)).toBe(NOW_S + 3600);
    expect(expiresAt.getTime()).toBe((NOW_S + 3600) * 1000);
    expect(id).toBe(turnOpaqueId(SECRET, SID));
    expect(turnCredentials(SECRET, SID, 300, NOW).username.startsWith(`${NOW_S + 300}:`)).toBe(true);
  });

  test("the opaque id is the documented subkey HMAC, truncated to 16 bytes, base64url", async () => {
    const subkey = await hmac("SHA-256", SECRET, TURN_ID_LABEL);
    const full = await hmac("SHA-256", subkey, SID);
    expect(TURN_ID_BYTES).toBeGreaterThanOrEqual(16);
    expect(turnOpaqueId(SECRET, SID)).toBe(Buffer.from(full.subarray(0, TURN_ID_BYTES)).toString("base64url"));
    expect(turnOpaqueId(SECRET, SID)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("the opaque id is stable per session, differs between sessions and secrets, and hides the session id", () => {
    const id = turnOpaqueId(SECRET, SID);
    expect(turnOpaqueId(SECRET, SID)).toBe(id);
    expect(turnOpaqueId(SECRET, OTHER)).not.toBe(id);
    expect(turnOpaqueId(`${SECRET}x`, SID)).not.toBe(id);
    const username = turnCredentials(SECRET, SID, 3600, NOW).username;
    for (const part of [SID, SID.replaceAll("-", ""), ...SID.split("-")]) expect(username).not.toContain(part);
    // Not the credential scheme's own HMAC of the session id either.
    expect(id).not.toBe(turnPassword(SECRET, SID).slice(0, 22));
  });

  test("refreshes keep one quota key: coturn drops an all-digit prefix before ':' when counting user-quota", () => {
    // coturn 4.18 get_real_username (userdb.c): with use-auth-secret, "<digits>:<rest>" counts as <rest>.
    const quotaKey = (u: string) => {
      const i = u.indexOf(":");
      return i > 0 && /^\d+$/.test(u.slice(0, i)) ? u.slice(i + 1) : u;
    };
    const a = turnCredentials(SECRET, SID, 3600, NOW).username;
    const b = turnCredentials(SECRET, SID, 3600, new Date(NOW.getTime() + 61_000)).username;
    expect(a).not.toBe(b);
    expect(quotaKey(a)).toBe(quotaKey(b));
    expect(quotaKey(a)).toBe(turnOpaqueId(SECRET, SID));
    expect(quotaKey(turnCredentials(SECRET, OTHER, 3600, NOW).username)).not.toBe(quotaKey(a));
  });
});

describe("iceServersFor", () => {
  const stun = ["stun:example.test:3478"];
  const turn = ["turn:example.test:3478?transport=udp"];

  test("STUN only: one entry without credentials, nothing expires", () => {
    expect(iceServersFor({ stunUrls: stun, turnUrls: [], secret: SECRET, ttlSeconds: 3600 }, SID, NOW)).toEqual({
      iceServers: [{ urls: stun }],
      expiresAt: null,
    });
  });

  test("STUN only needs no secret", () => {
    expect(iceServersFor({ stunUrls: stun, turnUrls: [], ttlSeconds: 3600 }, SID, NOW).expiresAt).toBeNull();
  });

  test("STUN and TURN: the STUN entry plain, the TURN entry with credentials that expire", () => {
    const a = iceServersFor({ stunUrls: stun, turnUrls: turn, secret: SECRET, ttlSeconds: 3600 }, SID, NOW);
    const creds = turnCredentials(SECRET, SID, 3600, NOW);
    expect(a.iceServers).toEqual([
      { urls: stun },
      { urls: turn, username: creds.username, credential: creds.credential },
    ]);
    expect(a.expiresAt?.getTime()).toBe((NOW_S + 3600) * 1000);
  });

  test("TURN without STUN: just the TURN entry", () => {
    const a = iceServersFor({ stunUrls: [], turnUrls: turn, secret: SECRET, ttlSeconds: 600 }, SID, NOW);
    expect(a.iceServers).toHaveLength(1);
    expect(a.iceServers[0]?.urls).toEqual(turn);
    expect(a.expiresAt?.getTime()).toBe((NOW_S + 600) * 1000);
  });

  test("nothing configured: no servers, nothing expires", () => {
    expect(iceServersFor({ stunUrls: [], turnUrls: [], ttlSeconds: 3600 }, SID, NOW)).toEqual({
      iceServers: [],
      expiresAt: null,
    });
  });

  test("TURN without a secret fails closed", () => {
    expect(() => iceServersFor({ stunUrls: stun, turnUrls: turn, ttlSeconds: 3600 }, SID, NOW)).toThrow(
      TurnNotConfigured,
    );
    expect(() => iceServersFor({ stunUrls: stun, turnUrls: turn, secret: "", ttlSeconds: 3600 }, SID, NOW)).toThrow(
      TurnNotConfigured,
    );
  });

  test("the answer does not share the configured arrays (callers cannot mutate the env)", () => {
    const urls = [...stun];
    const a = iceServersFor({ stunUrls: urls, turnUrls: [], ttlSeconds: 3600 }, SID, NOW);
    a.iceServers[0]?.urls.push("stun:other.test");
    expect(urls).toEqual(stun);
  });
});
