// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inbox front door (ADR 0030 decision 5): cheap checks only, then store the raw request for
 * the worker and answer 202. The API never verifies a signature and never fetches anything here:
 * the sender's key is a URL a stranger chose, and the SSRF guard lives in the worker.
 *
 * Checks, in order: content type; body size (`FEDERATION_RULES.inboxMaxBytes`) and JSON; the
 * activity type (`Follow`, `Undo`, `Delete`; anything else is 202 and dropped unstored); the
 * `actor` host equals the `Signature` `keyId` host and is not blocked (domain or subdomain); the
 * `Date` within the skew; a per-domain rate limit. Refusals are 4xx and counted by reason only.
 */
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { parseSignatureHeader, FUTURE_SKEW_SECONDS } from "@commonair/federation";
import { schema } from "@commonair/db";
import { meter } from "@commonair/observability";
import type { Deps } from "../deps.ts";
import { emit } from "../events/outbox.ts";
import type { RateLimitRule } from "../lib/ratelimit.ts";
import { blockFor } from "./blocks.ts";
import { hostOf } from "./ids.ts";

/** The activity types the worker applies (decision 5). */
export const HANDLED_TYPES = ["Follow", "Undo", "Delete"] as const;
export type HandledType = (typeof HANDLED_TYPES)[number];

/** Per remote domain: a busy server's fan-out of `Delete`s fits, a flood does not. */
export const INBOX_DOMAIN_RULE: RateLimitRule = { max: 300, windowMs: 60_000 };

/** Headers never stored: credentials and client addresses (the item outlives the request). */
const DROPPED_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
]);
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 4096;

/** RFC 7231 IMF-fixdate, as `verifyRequest` requires (`packages/federation/src/signature.ts`). */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-3]\d (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} [0-2]\d:[0-5]\d:[0-6]\d GMT$/;

export type InboxRefusal =
  | "unsupported_media_type"
  | "too_large"
  | "malformed"
  | "missing_signature"
  | "key_actor_mismatch"
  | "insecure_actor"
  | "blocked"
  | "bad_date"
  | "date_skew"
  | "rate_limited";

const STATUS: Record<InboxRefusal, number> = {
  unsupported_media_type: 415,
  too_large: 413,
  malformed: 400,
  missing_signature: 401,
  key_actor_mismatch: 401,
  insecure_actor: 400,
  blocked: 403,
  bad_date: 401,
  date_skew: 401,
  rate_limited: 429,
};

export type InboxOutcome =
  | { kind: "stored"; itemId: string; type: HandledType }
  | { kind: "dropped"; type: string }
  | { kind: "refused"; reason: InboxRefusal; status: number; retryAfterSeconds?: number };

const m = meter("commonair.api");
/** By reason or type only: no ids, hosts or addresses in labels. */
const metrics = {
  refused: m.createCounter("federation.inbox.refused", { description: "Inbox requests refused by the cheap checks" }),
  accepted: m.createCounter("federation.inbox.accepted", { description: "Inbox items stored for the worker" }),
  dropped: m.createCounter("federation.inbox.dropped", { description: "Inbox activities of unhandled types" }),
};

/** `application/activity+json`, or `application/ld+json` with any profile. */
export function isActivityContentType(value: string | null): boolean {
  if (!value) return false;
  const type = value.split(";")[0]?.trim().toLowerCase();
  return type === "application/activity+json" || type === "application/ld+json";
}

/** The body as text, or null once it passes `max` bytes (read no further than that). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** The `Date` check, as the worker's `verifyRequest` applies it (past skew; a smaller future margin). */
export function dateRefusal(raw: string | null, now: Date, skewSeconds: number): "bad_date" | "date_skew" | null {
  if (!raw || !IMF_FIXDATE.test(raw.trim())) return "bad_date";
  const at = Date.parse(raw.trim());
  if (Number.isNaN(at)) return "bad_date";
  const diff = now.getTime() - at;
  if (diff > skewSeconds * 1000 || -diff > Math.min(skewSeconds, FUTURE_SKEW_SECONDS) * 1000) return "date_skew";
  return null;
}

/** The headers kept with the item, lower-cased, plus `(request-target)` for the worker's signing string. */
export function storedHeaders(req: Request, path: string): Record<string, string> {
  const out: Record<string, string> = { "(request-target)": `${req.method.toLowerCase()} ${path}` };
  let n = 0;
  req.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key) || key.startsWith("x-forwarded-") || n >= MAX_HEADERS) return;
    out[key] = value.slice(0, MAX_HEADER_VALUE);
    n++;
  });
  return out;
}

export interface InboxSeams {
  now: Date;
  maxBytes: number;
  skewSeconds: number;
  /** `http:` actors are refused unless the instance allows private networks (harness peers). */
  allowHttp: boolean;
  blockFor(host: string): Promise<string | null>;
  rateLimit(host: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  store(item: { headers: Record<string, string>; body: string }): Promise<string>;
}

const refuse = (reason: InboxRefusal, retryAfterSeconds?: number): InboxOutcome => ({
  kind: "refused",
  reason,
  status: STATUS[reason],
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

const idOf = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
};

/** Run the cheap checks on one inbox request (`path` is its request target, with any query). */
export async function checkInbox(req: Request, path: string, seams: InboxSeams): Promise<InboxOutcome> {
  if (!isActivityContentType(req.headers.get("content-type"))) return refuse("unsupported_media_type");
  const text = await readCapped(req, seams.maxBytes);
  if (text === null) return refuse("too_large");
  let activity: unknown;
  try {
    activity = JSON.parse(text);
  } catch {
    return refuse("malformed");
  }
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return refuse("malformed");
  const type = (activity as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0 || type.length > 64) return refuse("malformed");
  if (!(HANDLED_TYPES as readonly string[]).includes(type)) return { kind: "dropped", type };

  const actor = idOf((activity as { actor?: unknown }).actor);
  const actorHost = actor ? hostOf(actor) : null;
  if (!actor || !actorHost) return refuse("malformed");
  if (!seams.allowHttp && new URL(actor).protocol !== "https:") return refuse("insecure_actor");
  const sig = parseSignatureHeader(req.headers.get("signature") ?? "");
  if (!sig) return refuse("missing_signature");
  if (hostOf(sig.keyId) !== actorHost) return refuse("key_actor_mismatch");
  if (await seams.blockFor(actorHost)) return refuse("blocked");
  const date = dateRefusal(req.headers.get("date"), seams.now, seams.skewSeconds);
  if (date) return refuse(date);
  const rl = await seams.rateLimit(actorHost);
  if (!rl.allowed) return refuse("rate_limited", rl.retryAfterSeconds);

  const itemId = await seams.store({ headers: storedHeaders(req, path), body: text });
  return { kind: "stored", itemId, type: type as HandledType };
}

/** Store the item and its `federation.inbox.received` event in one transaction. */
export async function storeInboxItem(
  deps: Pick<Deps, "db">,
  channelId: string | null,
  item: { headers: Record<string, string>; body: string },
  now: Date,
): Promise<string> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.federationInboxItems)
      .values({ channelId, headers: item.headers, body: item.body, receivedAt: now })
      .returning({ id: schema.federationInboxItems.id });
    if (!row) throw new Error("inbox item insert returned nothing");
    await emit(tx, "federation.inbox.received", channelId, { item_id: row.id }, now);
    return row.id;
  });
}

/** The real seams: the block list, the Valkey rate limiter and the store. */
export function inboxSeams(deps: Deps, channelId: string | null): InboxSeams {
  const now = deps.now();
  return {
    now,
    maxBytes: FEDERATION_RULES.inboxMaxBytes,
    skewSeconds: FEDERATION_RULES.dateSkewSeconds,
    allowHttp: deps.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
    blockFor: (host) => blockFor(deps.db, host),
    rateLimit: (host) =>
      deps.rateLimitStore.hit(
        KEYS.rateLimit("federation", `inbox:${host}`),
        INBOX_DOMAIN_RULE,
        now.getTime(),
        `${now.getTime()}:${crypto.randomUUID()}`,
      ),
    store: (item) => storeInboxItem(deps, channelId, item, now),
  };
}

/** Count the outcome (labels: reason or type, never who). */
export function recordInboxOutcome(o: InboxOutcome): void {
  if (o.kind === "refused") metrics.refused.add(1, { reason: o.reason });
  else if (o.kind === "dropped") metrics.dropped.add(1);
  else metrics.accepted.add(1, { type: o.type });
}
