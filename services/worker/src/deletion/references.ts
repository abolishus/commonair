// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which outbox rows (`events`) belong to a deleted user (e6 spec "Account deletion (additions)").
 *
 * An event references the user when any string in its payload, at any depth, is their id or
 * their email address (both case-insensitive), or is exactly their username, display name or
 * display username, or a mention of one (`@name`): a reply quotes the parent's login without the
 * parent's id, and a mention fragment carries only `@login`. An anonymous tip carries no id, so
 * a `channel.tip` on a channel they tipped whose message is one of their tip messages is theirs
 * too. Whole values only: someone else's chat line that merely contains their name is that
 * person's text and stays. The SQL prefilter (`eventNeedles`) only narrows the scan; this
 * function decides.
 */

export interface DeletedIdentity {
  id: string;
  /** Username, display name and display username, as they were before pseudonymization. */
  names: readonly string[];
  email: string;
  /** Non-empty messages of the user's tips, by channel id. */
  tipMessages: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface OutboxEvent {
  type: string;
  channelId: string | null;
  payload: unknown;
}

function walk(value: unknown, visit: (value: string) => boolean): boolean {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.some((v) => walk(v, visit));
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>).some((v) => walk(v, visit));
  return false;
}

export function referencesUser(event: OutboxEvent, who: DeletedIdentity): boolean {
  const id = who.id.toLowerCase();
  const email = who.email.toLowerCase();
  const names = new Set(who.names.filter((n) => n !== "").flatMap((n) => [n, `@${n}`]));
  const hit = walk(event.payload, (v) => {
    const folded = v.toLowerCase();
    return folded === id || (email !== "" && folded === email) || names.has(v);
  });
  if (hit) return true;
  if (event.type !== "channel.tip" || event.channelId === null) return false;
  const message = (event.payload as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== "" && (who.tipMessages.get(event.channelId)?.has(message) ?? false);
}

const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

/**
 * Substrings at least one of which appears in the text of every payload `referencesUser`
 * accepts, JSON-escaped the way Postgres renders jsonb as text: `exact` ones are matched as
 * they are, `folded` ones (the id and the email, which compare case-insensitively) against the
 * lower-cased text.
 */
export function eventNeedles(who: DeletedIdentity): { exact: string[]; folded: string[] } {
  const exact = [...who.names, ...[...who.tipMessages.values()].flatMap((s) => [...s])].filter((s) => s !== "");
  const folded = [who.id, who.email].filter((s) => s !== "").map((s) => s.toLowerCase());
  return { exact: [...new Set(exact.map(jsonText))], folded: [...new Set(folded.map(jsonText))] };
}
