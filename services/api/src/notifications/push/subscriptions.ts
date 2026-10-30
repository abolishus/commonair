// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser push subscriptions (ADR 0028 decision 6): validate what a browser hands us, find a
 * subscription by an HMAC of its endpoint, and store it encrypted. A browser belongs to the last
 * member who subscribed it; a member keeps at most `maxPushSubscriptionsPerUser` browsers.
 */
import { NOTIFY_RULES, NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { schema, type Database } from "@commonair/db";
import { encryptSecret, fromB64url, hmacHex } from "@commonair/tokens";
import { and, count, desc, eq, notInArray } from "drizzle-orm";
import { badRequest } from "../../lib/errors.ts";

const { pushSubscriptions } = schema;

export const MAX_ENDPOINT_LENGTH = 2048;

/** RFC 8030 push endpoint rules: absolute `https:` (or `http:` for the harness), no credentials, a host. */
export function validateEndpoint(raw: string, allowInsecure: boolean): string {
  if (raw.length > MAX_ENDPOINT_LENGTH) throw badRequest("The push endpoint is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("The push endpoint is not a URL");
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:"))
    throw badRequest("The push endpoint must be https");
  if (url.username || url.password) throw badRequest("The push endpoint must not carry credentials");
  if (!url.hostname) throw badRequest("The push endpoint has no host");
  // Stored as given: the browser sends the same string to unsubscribe, and the hash must match.
  return raw;
}

export interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

function decodeKey(value: string): Uint8Array {
  try {
    return fromB64url(value.replace(/=+$/, ""));
  } catch {
    throw badRequest("The push keys are not base64url");
  }
}

/**
 * The keys in the unpadded form `fromB64url` (and the worker) read: `p256dh` an uncompressed
 * P-256 point (65 bytes, 0x04 first), `auth` 16 bytes.
 */
export function normalizeKeys(keys: SubscriptionKeys): SubscriptionKeys {
  const p256dh = keys.p256dh.replace(/=+$/, "");
  const auth = keys.auth.replace(/=+$/, "");
  const point = decodeKey(p256dh);
  if (point.length !== 65 || point[0] !== 0x04)
    throw badRequest("p256dh must be an uncompressed P-256 point (65 bytes)");
  if (decodeKey(auth).length !== 16) throw badRequest("auth must be 16 bytes");
  return { p256dh, auth };
}

/** `push_subscriptions.endpoint_hash`. */
export const endpointHash = (authSecret: string, endpoint: string): Promise<string> =>
  hmacHex(authSecret, `${NOTIFY_SECRET_PURPOSES.pushEndpoint}:${endpoint}`);

/** `push_subscriptions.subscription`: the endpoint and keys, encrypted. */
export const sealSubscription = (authSecret: string, endpoint: string, keys: SubscriptionKeys): Promise<string> =>
  encryptSecret(
    authSecret,
    NOTIFY_SECRET_PURPOSES.pushSubscription,
    JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth }),
  );

/**
 * Store (or take over) one browser's subscription for `userId`, then drop the member's oldest
 * browsers beyond the cap. One transaction, so the cap holds after every call.
 */
export async function upsertSubscription(
  db: Database,
  input: { userId: string; hash: string; subscription: string; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(pushSubscriptions)
      .values({
        userId: input.userId,
        endpointHash: input.hash,
        subscription: input.subscription,
        createdAt: input.now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpointHash,
        // A re-subscribe is this member's newest browser: it must not be the next one dropped.
        set: { userId: input.userId, subscription: input.subscription, failures: 0, createdAt: input.now },
      });
    const keep = tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, input.userId))
      .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
      .limit(NOTIFY_RULES.maxPushSubscriptionsPerUser);
    await tx
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, input.userId), notInArray(pushSubscriptions.id, keep)));
  });
}

/** Forget one browser, only if it is the caller's. */
export async function deleteSubscription(db: Database, userId: string, hash: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpointHash, hash)));
}

export async function countSubscriptions(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  return row?.n ?? 0;
}
