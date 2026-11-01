// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OAuth `state` of the Twitch import (ADR 0031): an HMAC over the channel, the member and a
 * hash of their session, with a 10-minute expiry and a one-time nonce. The callback accepts it only
 * from the same session (first-party cookies), once. The key is derived from `AUTH_SECRET` with its
 * own label, so a state can never pass as any other signed value.
 */
import { sha256Hex } from "@commonair/tokens";

export const STATE_TTL_MS = 10 * 60 * 1000;
const LABEL = "commonair/twitch-import-state/v1";

export interface StatePayload {
  v: 1;
  /** Channel id. */
  c: string;
  /** User id. */
  u: string;
  /** SHA-256 (hex) of the session id: the state never carries the session id itself. */
  s: string;
  /** One-time nonce. */
  n: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function key(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(LABEL)));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const sessionHash = (sessionId: string): Promise<string> => sha256Hex(`${LABEL}:${sessionId}`);

export async function signState(
  secret: string,
  input: { channelId: string; userId: string; sessionId: string; now: Date },
): Promise<{ state: string; payload: StatePayload }> {
  const payload: StatePayload = {
    v: 1,
    c: input.channelId,
    u: input.userId,
    s: await sessionHash(input.sessionId),
    n: crypto.randomUUID(),
    e: input.now.getTime() + STATE_TTL_MS,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(body)));
  return { state: `${body}.${b64url(sig)}`, payload };
}

export type StateCheck =
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Verify the signature and the expiry (the session and the one-time use are the caller's). */
export async function verifyState(secret: string, state: string, now: Date): Promise<StateCheck> {
  const m = /^([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (!m?.[1] || !m[2]) return { ok: false, reason: "malformed" };
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    Buffer.from(m[2], "base64url"),
    new TextEncoder().encode(m[1]),
  );
  if (!ok) return { ok: false, reason: "signature" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.c !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.s !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.e !== "number"
  )
    return { ok: false, reason: "malformed" };
  if (payload.e <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
