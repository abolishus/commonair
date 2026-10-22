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
 * An anonymous tip carries no id, and `tips` rows link to no event, so it can only be matched by
 * fingerprint (channel, amount, currency, non-empty message), which someone else's tip can share
 * (a 100-cent `gg`). A matched anonymous tip is therefore never deleted, only its message is
 * replaced (`redactAnonymousTip`): what is left (an anonymous amount on a channel) identifies no one,
 * and a stranger's identical tip loses only its stock words, never the event or its deliveries.
 *
 * Someone else's event that only mentions them (an `@ulla` fragment, an address typed into chat)
 * is that person's and is kept, with the mentions replaced (`redactPayload`), only in free-text
 * fields, so enums, amounts and ids are never touched. In text a login is redacted as an `@login`
 * token; as a bare word only when it cannot be an ordinary word (`isDistinctiveLogin`), because a
 * user named `the` must not rewrite every other chat line on the platform.
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

/**
 * A login that mixes letters with digits or underscores (`ulla_92`) is not a word anyone types by
 * chance, so it is redacted bare in text too. Any other login (`the`, `ulla`, `everyone`) only as
 * `@login` or as a whole `mention` fragment.
 */
export function isDistinctiveLogin(login: string): boolean {
  return /\p{L}/u.test(login) && /[\d_]/.test(login);
}

const lowerSet = (xs: readonly string[]) => new Set(xs.filter((x) => x !== "").map((x) => x.toLowerCase()));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function some(value: unknown, visit: (obj: Json) => boolean, leaf: (s: string) => boolean): boolean {
  if (typeof value === "string") return leaf(value);
  if (Array.isArray(value)) return value.some((v) => some(v, visit, leaf));
  if (isObject(value)) return visit(value) || Object.values(value).some((v) => some(v, visit, leaf));
  return false;
}

/** Whether an anonymous `channel.tip` has the fingerprint of one of their tips (see the module note). */
export function anonymousTipMatches(event: OutboxEvent, who: DeletedIdentity): boolean {
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
  return some(event.payload, visit, leaf);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern for every mention in text: the email anywhere, a login as a whole `@login` token, and
 * bare only when distinctive.
 */
function mentionPattern(who: DeletedIdentity): RegExp | null {
  const parts = [
    ...(who.email !== "" ? [escapeRe(who.email)] : []),
    ...[...lowerSet(who.logins)].map(
      (l) => `(?<![\\w@.-])${isDistinctiveLogin(l) ? "@?" : "@"}${escapeRe(l)}(?![\\w-])`,
    ),
  ];
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}

/** A chat `mention` fragment whose whole text is one of their logins, with or without `@`. */
function isTheirMentionFragment(obj: Json, logins: ReadonlySet<string>): boolean {
  return obj.type === "mention" && typeof obj.text === "string" && logins.has(obj.text.replace(/^@/, "").toLowerCase());
}

/**
 * Someone else's payload with every mention of the user in a free-text field replaced by
 * `REDACTED`. Returns null when nothing changed.
 */
export function redactPayload(payload: unknown, who: DeletedIdentity): unknown {
  const re = mentionPattern(who);
  if (!re) return null;
  const logins = lowerSet(who.logins);
  let changed = false;
  const go = (value: unknown, key: string | null): unknown => {
    if (isObject(value) && isTheirMentionFragment(value, logins)) {
      changed = true;
      return { ...value, text: REDACTED };
    }
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

/**
 * A fingerprint-matched anonymous tip with its message replaced; null when it does not match or is
 * already redacted.
 */
export function redactAnonymousTip(event: OutboxEvent, who: DeletedIdentity): unknown {
  if (!anonymousTipMatches(event, who) || !isObject(event.payload)) return null;
  return { ...event.payload, message: REDACTED };
}

const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

/**
 * Lower-cased substrings at least one of which appears in the lower-cased jsonb text of every
 * payload `referencesUser` accepts or
 * `redactPayload` changes. Only narrows the scan; the functions above decide.
 */
export function eventNeedles(who: DeletedIdentity): string[] {
  const logins = [...lowerSet(who.logins)].map((l) =>
    // Ordinary-word logins match only as a whole value (a `…_login` key, a bare mention fragment)
    // or an `@mention`, so a login like `the` does not pull in the whole table.
    isDistinctiveLogin(l) ? [l] : [`"${l}"`, `@${l}`],
  );
  const needles = [who.id, who.email]
    .filter((x) => x !== "")
    .map((x) => x.toLowerCase())
    .concat(logins.flat());
  return [...new Set(needles.map((n) => (n.startsWith('"') ? `"${jsonText(n.slice(1, -1))}"` : jsonText(n))))];
}
