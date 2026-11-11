// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's calendar feed (RFC 5545): one VCALENDAR with a VEVENT per upcoming occurrence.
 * Times are UTC (`Z`), so no VTIMEZONE is needed; each occurrence is its own event, so a skipped
 * week simply has none. The UID of a slot's occurrence is the slot id plus its start, stable
 * across fetches, so a subscribed calendar updates the event instead of duplicating it. Pure,
 * unit-tested.
 */
import type { Occurrence } from "./expand.ts";

const encoder = new TextEncoder();

/** TEXT escaping (RFC 5545 §3.3.11): backslash, semicolon, comma and line breaks. */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * One content line folded at 75 octets (§3.1): each continuation starts with a space. Folds fall
 * between code points, never inside a UTF-8 sequence.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let size = 0;
  // The first line holds 75 octets; continuations hold 74 after their leading space.
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > limit) {
      out.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** An instant as an iCalendar UTC DATE-TIME: 20261113T003000Z. */
export function icsDateTime(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** The occurrence's UID: the slot and its start, or the one-off. */
export function occurrenceUid(o: Pick<Occurrence, "slotId" | "oneOffId" | "startsAt">, host: string): string {
  if (o.slotId) return `slot-${o.slotId}-${icsDateTime(o.startsAt)}@${host}`;
  return `oneoff-${o.oneOffId ?? icsDateTime(o.startsAt)}@${host}`;
}

export interface FeedInput {
  /** The instance name, for PRODID and the calendar's name. */
  instanceName: string;
  /** The instance's public origin, no trailing slash ("https://example.org"). */
  publicUrl: string;
  channel: { slug: string; displayName: string };
  occurrences: readonly Occurrence[];
  /** DTSTAMP: when the schedule last changed, so the same schedule yields the same bytes. */
  stamp: Date;
}

/** The whole feed, CRLF line endings, ending with one. */
export function buildFeed(input: FeedInput): string {
  const host = new URL(input.publicUrl).host;
  const channelUrl = `${input.publicUrl}/${input.channel.slug}`;
  const stamp = icsDateTime(input.stamp);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeText(input.instanceName)}//Channel schedule//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.channel.displayName)}`,
    `NAME:${escapeText(input.channel.displayName)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const o of input.occurrences) {
    const summary = o.title ?? input.channel.displayName;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${occurrenceUid(o, host)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDateTime(o.startsAt)}`,
      `DTEND:${icsDateTime(o.endsAt)}`,
      `SUMMARY:${escapeText(summary)}`,
      ...(o.title ? [`DESCRIPTION:${escapeText(input.channel.displayName)}`] : []),
      ...(o.category ? [`CATEGORIES:${escapeText(o.category.name)}`] : []),
      `URL:${channelUrl}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
