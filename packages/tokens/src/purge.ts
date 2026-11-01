// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed relay purge batch (batch 7 decision (x), ADR 0016 Amendment 1), answered by
 * `GET /api/relay/purges?after=<seq>`. The origin signs it with the playback key
 * (`PLAYBACK_SIGNING_KEY`), which relays already trust as `originPublicKey`, so it needs no new
 * key. The envelope is the receipt's: `{ payload, signature }`, base64url, the signature over the
 * exact payload bytes. `relay/internal/tokens/purge.go` mirrors the schema and the canonical-bytes
 * rule; vectors.json (`purge`) pins both.
 *
 * `payload.seq` is the cursor the relay sends as `after` next time: the last item's `seq`, or the
 * request's `after` when there is nothing new. Items are strictly ascending by `seq`. Replaying an
 * old batch only evicts again, so a batch carries no expiry.
 */
import { z } from "zod";
import { b64url, fromB64url, importVerifyKey, type SigningKey } from "./index.ts";

/** Most items in one batch (the feed answers at most this many rows). */
export const PURGE_BATCH_MAX_ITEMS = 500;
/**
 * A relay cache path prefix ending in "/": `dvr/<vodId>/`, `live/<slug>/` or
 * `live/<slug>/captions/`. No segment starts with a dot, so there is no `..`.
 */
export const PURGE_PREFIX = /^(?:live|dvr)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/;
export const PURGE_PREFIX_MAX_LENGTH = 256;
/** A short reason code, for relay logs and metrics. */
export const PURGE_REASON = /^[a-z][a-z0-9_]{0,31}$/;

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PurgeItem = z.strictObject({
  seq: seq.min(1),
  prefix: z.string().max(PURGE_PREFIX_MAX_LENGTH).regex(PURGE_PREFIX),
  reason: z.string().regex(PURGE_REASON),
});
export type PurgeItem = z.infer<typeof PurgeItem>;

/** Key order is the byte order of the payload (Go marshals the same struct order). */
export const PurgeBatch = z
  .strictObject({ seq, items: z.array(PurgeItem).max(PURGE_BATCH_MAX_ITEMS) })
  .superRefine((b, ctx) => {
    for (let i = 1; i < b.items.length; i++)
      if ((b.items[i] as PurgeItem).seq <= (b.items[i - 1] as PurgeItem).seq)
        ctx.addIssue({ code: "custom", path: ["items", i, "seq"], message: "items are not strictly ascending" });
    const last = b.items.at(-1);
    if (last && last.seq !== b.seq)
      ctx.addIssue({ code: "custom", path: ["seq"], message: "seq is not the last item's" });
  });
export type PurgeBatch = z.infer<typeof PurgeBatch>;

export interface SignedPurgeBatch {
  payload: string;
  signature: string;
}

export type PurgeError = "malformed" | "non_canonical" | "bad_signature";
export type PurgeVerifyResult = { ok: true; value: PurgeBatch } | { ok: false; error: PurgeError };

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Sign a batch with the origin playback key. Throws on an invalid batch. */
export async function signPurgeBatch(key: SigningKey, batch: PurgeBatch): Promise<SignedPurgeBatch> {
  const bytes = enc.encode(JSON.stringify(PurgeBatch.parse(batch)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, bytes));
  return { payload: b64url(bytes), signature: b64url(sig) };
}

/** Verify a batch against the origin public key (raw 32 bytes, base64url). */
export async function verifyPurgeBatch(
  originPublicKeyB64: string,
  signed: SignedPurgeBatch,
): Promise<PurgeVerifyResult> {
  let bytes: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  let key: CryptoKey;
  try {
    bytes = fromB64url(signed.payload);
    sig = fromB64url(signed.signature);
    key = await importVerifyKey(originPublicKeyB64);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (sig.length !== 64 || !(await crypto.subtle.verify({ name: "Ed25519" }, key, sig, bytes)))
    return { ok: false, error: "bad_signature" };
  let text: string;
  let parsed: ReturnType<typeof PurgeBatch.safeParse>;
  try {
    text = dec.decode(bytes);
    parsed = PurgeBatch.safeParse(JSON.parse(text));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!parsed.success) return { ok: false, error: "malformed" };
  if (JSON.stringify(parsed.data) !== text) return { ok: false, error: "non_canonical" };
  return { ok: true, value: parsed.data };
}
