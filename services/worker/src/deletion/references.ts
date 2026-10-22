// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which outbox rows (`events`) belong to a deleted user (e6 spec "Account deletion (additions)"),
 * and how other people's rows are cleaned of them.
 *
 * Matching is on identity only, never on arbitrary values: a common word that happens to equal a
 * user's display name (`text`, `usd`, `1000`) must never take other people's events with it. An
 * event is the user's when, at any depth:
 *
 * - a string is their id or their email (case-insensitive; both are unique);
 * - a `…_login` key holds one of their logins (username, display username, channel slug; unique)
 *   and its sibling `…_id`, if the object has one, is theirs or null: a reply quotes the parent's
 *   login (and their words) without an id, and a login that changed hands later is someone else's.
 *
 * Display names are not identifiers (several people can share one); every payload field that
 * carries one sits next to the id it belongs to, so the id rule covers it.
 *
 * An anonymous tip carries no id: an anonymous `channel.tip` is theirs when its channel, amount,
 * currency and non-empty message are those of one of their tips (`tips` rows link to no event).
 *
 * Someone else's event that only mentions them (an `@ulla` fragment, `thanks ulla`, an address
 * typed into chat) is that person's and is kept, with the mentions replaced (`redactPayload`):
 * whole-word logins and the email, only in free-text fields, so enums, amounts and ids are never
 * touched.
 */

export interface TipFingerprint {
  channelId: string;
  amountCents: number;
  currency: string;
  message: string;
}

export interface DeletedIdentity {
  id: string;
  /** Username, display username and channel slug, as they were before pseudonymization. */
  logins: readonly string[];
  email: string;
  /** The user's tips with a non-empty message. */
  tips: readonly TipFingerprint[];
}

export interface OutboxEvent {
  type: string;
  channelId: string | null;
  payload: unknown;
}

/** What replaces a mention of a deleted user in someone else's text. */
export const REDACTED = "[deleted]";

/** Free-text payload fields (chat lines, tip messages, quoted replies, ban reasons, titles). */
const FREE_TEXT_KEYS = new Set(["text", "message", "parent_message_body", "reason", "title", "description"]);

/** Logins shorter than this are redacted inside text only as an `@mention`. */
const MIN_REDACT_LENGTH = 3;

const lowerSet = (xs: readonly string[]) => new Set(xs.filter((x) => x !== "").map((x) => x.toLowerCase()));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function some(value: unknown, visit: (obj: Json) => boolean, leaf: (s: string) => boolean): boolean {
  if (typeof value === "string") return leaf(value);
  if (Array.isArray(value)) return value.some((v) => some(v, visit, leaf));
  if (isObject(value)) return visit(value) || Object.values(value).some((v) => some(v, visit, leaf));
  return false;
}

function anonymousTipIsTheirs(event: OutboxEvent, who: DeletedIdentity): boolean {
  if (event.type !== "channel.tip" || event.channelId === null || !isObject(event.payload)) return false;
  const p = event.payload;
  if (p.is_anonymous !== true || (p.user_id !== null && p.user_id !== undefined)) return false;
  const amount = isObject(p.amount) ? p.amount : null;
  if (typeof p.message !== "string" || p.message === "" || !amount) return false;
  return who.tips.some(
    (t) =>
      t.channelId === event.channelId &&
      t.message === p.message &&
      t.amountCents === amount.value &&
      t.currency.toLowerCase() === String(amount.currency).toLowerCase(),
  );
}

export function referencesUser(event: OutboxEvent, who: DeletedIdentity): boolean {
  const id = who.id.toLowerCase();
  const email = who.email.toLowerCase();
  const logins = lowerSet(who.logins);
  const isLogin = (v: unknown) => typeof v === "string" && logins.has(v.toLowerCase());
  const visit = (obj: Json) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!k.endsWith("_login") || !isLogin(v)) continue;
      const sibling = obj[`${k.slice(0, -"_login".length)}_id`];
      if (sibling === undefined || sibling === null || (typeof sibling === "string" && sibling.toLowerCase() === id))
        return true;
    }
    return false;
  };
  const leaf = (v: string) => {
    const folded = v.toLowerCase();
    return folded === id || (email !== "" && folded === email);
  };
  return some(event.payload, visit, leaf) || anonymousTipIsTheirs(event, who);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pattern for every mention: the email anywhere, a login as a whole word (`@` optional when long). */
function mentionPattern(who: DeletedIdentity): RegExp | null {
  const parts = [
    ...(who.email !== "" ? [escapeRe(who.email)] : []),
    ...[...lowerSet(who.logins)].map(
      (l) => `(?<![\\w@.-])${l.length >= MIN_REDACT_LENGTH ? "@?" : "@"}${escapeRe(l)}(?![\\w-])`,
    ),
  ];
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}

/**
 * Someone else's payload with every mention of the user in a free-text field replaced by
 * `REDACTED`. Returns null when nothing changed.
 */
export function redactPayload(payload: unknown, who: DeletedIdentity): unknown {
  const re = mentionPattern(who);
  if (!re) return null;
  let changed = false;
  const go = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") {
      if (key === null || !FREE_TEXT_KEYS.has(key)) return value;
      const next = value.replace(re, REDACTED);
      if (next !== value) changed = true;
      return next;
    }
    if (Array.isArray(value)) return value.map((v) => go(v, key));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, go(v, k)]));
    return value;
  };
  const out = go(payload, null);
  return changed ? out : null;
}

const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

/**
 * Lower-cased substrings at least one of which appears in the lower-cased jsonb text of every
 * payload `referencesUser` accepts (anonymous tips aside: those are found by channel) or
 * `redactPayload` changes. Only narrows the scan; the functions above decide.
 */
export function eventNeedles(who: DeletedIdentity): string[] {
  const logins = [...lowerSet(who.logins)].map((l) =>
    // Short logins match only as a whole value or an `@mention`, never inside other words.
    l.length >= MIN_REDACT_LENGTH ? [l] : [`"${l}"`, `@${l}`],
  );
  const needles = [who.id, who.email]
    .filter((x) => x !== "")
    .map((x) => x.toLowerCase())
    .concat(logins.flat());
  return [...new Set(needles.map((n) => (n.startsWith('"') ? `"${jsonText(n.slice(1, -1))}"` : jsonText(n))))];
}
