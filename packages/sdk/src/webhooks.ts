// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EventSub webhook verification (Twitch-shaped): the signature is
 * `sha256=` + hex(HMAC-SHA256(secret, message id + timestamp + raw body)), checked in constant time;
 * messages older than 10 minutes are refused; receivers dedupe by message id. Web Crypto only, so it
 * runs in Bun, Node, Deno, workers and browsers.
 */
import {
  SubscriptionEnvelope,
  WEBHOOK_HEADERS,
  WEBHOOK_MESSAGE_TYPES,
  verifyWebhook,
} from "@commonair/contracts/events";
import type { PublicEventType } from "@commonair/contracts/events";
import { z } from "zod";

/** Messages older (or further in the future) than this are refused (replay protection). */
export const WEBHOOK_MAX_AGE_MS = 10 * 60_000;

export type WebhookMessageType = (typeof WEBHOOK_MESSAGE_TYPES)[number];

/** The subscription envelope; `type` stays a string so a newer server's event types still verify. */
const Envelope = SubscriptionEnvelope.extend({ type: z.string() });
export type WebhookSubscription = Omit<z.infer<typeof SubscriptionEnvelope>, "type"> & {
  type: PublicEventType | (string & {});
};

const Body = z.object({
  subscription: Envelope,
  event: z.record(z.string(), z.unknown()).optional(),
  challenge: z.string().optional(),
});

export type VerifyFailure =
  | "missing_headers"
  | "unknown_message_type"
  | "stale_timestamp"
  | "bad_signature"
  | "invalid_body";

export type VerifiedWebhook =
  | {
      ok: true;
      messageType: WebhookMessageType;
      messageId: string;
      /** ISO 8601, as signed. */
      timestamp: string;
      /** How many times this message was sent before (0 on the first attempt). */
      retry: number;
      subscription: WebhookSubscription;
      /** `notification` messages. */
      event?: Record<string, unknown>;
      /** `webhook_callback_verification`: answer 200 with exactly this as `text/plain`. */
      challenge?: string;
    }
  | { ok: false; reason: VerifyFailure };

export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  // Node lower-cases incoming header names; accept any case from hand-built records.
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? v[0] : v;
}

export interface VerifyOptions {
  /** The secret you passed when subscribing. */
  secret: string;
  headers: HeaderSource;
  /** The body exactly as received: parse JSON only after verifying. */
  rawBody: string;
  /** Milliseconds since the epoch (tests). */
  now?: number;
}

/** Verify a webhook delivery from its headers and raw body. Check `ok` before trusting anything. */
export async function verifyEventSubRequest(opts: VerifyOptions): Promise<VerifiedWebhook> {
  const messageId = header(opts.headers, WEBHOOK_HEADERS.messageId);
  const timestamp = header(opts.headers, WEBHOOK_HEADERS.messageTimestamp);
  const signature = header(opts.headers, WEBHOOK_HEADERS.messageSignature);
  const messageType = header(opts.headers, WEBHOOK_HEADERS.messageType);
  if (!messageId || !timestamp || !signature || !messageType) return { ok: false, reason: "missing_headers" };
  if (!(WEBHOOK_MESSAGE_TYPES as readonly string[]).includes(messageType))
    return { ok: false, reason: "unknown_message_type" };
  const now = opts.now ?? Date.now();
  const age = now - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: "stale_timestamp" };
  if (!(await verifyWebhook(opts.secret, messageId, timestamp, opts.rawBody, signature, now)))
    return { ok: false, reason: "bad_signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  const body = Body.safeParse(parsed);
  if (!body.success) return { ok: false, reason: "invalid_body" };
  if (messageType === "webhook_callback_verification" && body.data.challenge === undefined)
    return { ok: false, reason: "invalid_body" };
  const retry = Number.parseInt(header(opts.headers, WEBHOOK_HEADERS.messageRetry) ?? "0", 10);
  return {
    ok: true,
    messageType: messageType as WebhookMessageType,
    messageId,
    timestamp,
    retry: Number.isFinite(retry) ? retry : 0,
    subscription: body.data.subscription,
    ...(body.data.event === undefined ? {} : { event: body.data.event }),
    ...(body.data.challenge === undefined ? {} : { challenge: body.data.challenge }),
  };
}

/** Verify a Web `Request` (Bun.serve, Deno, workers, Hono…). Reads a clone, so the body stays readable. */
export async function verifyEventSubWebRequest(
  request: Request,
  secret: string,
  opts: { now?: number } = {},
): Promise<VerifiedWebhook & { rawBody: string }> {
  const rawBody = await request.clone().text();
  const result = await verifyEventSubRequest({ secret, headers: request.headers, rawBody, now: opts.now });
  return { ...result, rawBody };
}

export interface Dedupe {
  /** True the first time an id is seen (and records it); false for a duplicate. */
  firstSeen(id: string): boolean;
  has(id: string): boolean;
  readonly size: number;
}

/** Remembers the last `maxEntries` message ids (oldest forgotten first). */
export function createDedupe(maxEntries = 1000): Dedupe {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  const ids = new Set<string>();
  return {
    firstSeen(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      // A Set iterates in insertion order: the first entry is the oldest.
      if (ids.size > maxEntries)
        for (const oldest of ids) {
          ids.delete(oldest);
          break;
        }
      return true;
    },
    has: (id) => ids.has(id),
    get size() {
      return ids.size;
    },
  };
}
