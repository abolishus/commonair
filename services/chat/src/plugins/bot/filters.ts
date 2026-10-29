// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bot's spam, caps and link filters (`BotConfig.filters`). Pure, linear in the message length
 * and free of regexes built from user input: the allowlist is compared as host strings.
 */
import type { NoticeCode } from "@commonair/contracts";
import type { BotConfig } from "@commonair/contracts/shapes";
import { containsLink } from "../../content.ts";
import type { Standing } from "../../types.ts";

export type BotFilters = BotConfig["filters"];
export type FilterKind = "spam" | "caps" | "links";

export interface FilterVerdict {
  kind: FilterKind;
  code: NoticeCode;
  text: string;
}

/** True when some character repeats more than `max` times in a row. */
export function hasRepeatRun(body: string, max: number): boolean {
  let prev: string | undefined;
  let run = 0;
  for (const ch of body) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > max) return true;
  }
  return false;
}

/** Long enough and the uppercase share of its letters above `maxRatio`. */
export function isShouting(body: string, minLength: number, maxRatio: number): boolean {
  let length = 0;
  let letters = 0;
  let upper = 0;
  for (const ch of body) {
    length++;
    const lower = ch.toLowerCase();
    const up = ch.toUpperCase();
    // Letters with case only: digits, punctuation, emoji and caseless scripts do not count.
    if (lower === up) continue;
    letters++;
    if (ch === up) upper++;
  }
  return length >= minLength && letters > 0 && upper / letters > maxRatio;
}

const EDGE_PUNCT = new Set("()[]{}<>\"'`,;:!?.*");
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The host of one link-looking token, lowercased, or null when none can be read from it. */
export function hostOf(token: string): string | null {
  let t = token.toLowerCase();
  let start = 0;
  while (start < t.length && EDGE_PUNCT.has(t.charAt(start))) start++;
  t = t.slice(start);
  const scheme = t.indexOf("://");
  if (scheme !== -1) t = t.slice(scheme + 3);
  let end = t.length;
  for (const sep of ["/", "?", "#"]) {
    const at = t.indexOf(sep);
    if (at !== -1 && at < end) end = at;
  }
  let authority = t.slice(0, end);
  const userinfo = authority.lastIndexOf("@");
  if (userinfo !== -1) authority = authority.slice(userinfo + 1);
  const port = authority.indexOf(":");
  if (port !== -1) authority = authority.slice(0, port);
  let stop = authority.length;
  while (stop > 0 && EDGE_PUNCT.has(authority.charAt(stop - 1))) stop--;
  const host = authority.slice(0, stop);
  return HOST.test(host) ? host : null;
}

/** Allowlist entries as bare hosts: "*.example.org" and ".example.org" mean "example.org". */
export function normalizeAllowlist(entries: readonly string[]): string[] {
  return entries
    .map((e) =>
      e
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, ""),
    )
    .map((e) => e.replace(/\.$/, ""))
    .filter((e) => e.length > 0);
}

/** The host is an allowlisted host or a subdomain of one. */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Every link in the body points at an allowlisted host. False when there is a link it cannot read. */
export function linksAllowlisted(body: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  for (const token of body.split(/\s+/u)) {
    if (!token || !containsLink(token)) continue;
    const host = hostOf(token);
    if (host === null || !hostAllowed(host, allowlist)) return false;
  }
  return true;
}

/**
 * The first filter the message trips, or null. The caller exempts the broadcaster, moderators,
 * VIPs and the bot itself; `standing` here only decides the subscriber link exemption.
 */
export function checkFilters(body: string, filters: BotFilters, standing: Standing): FilterVerdict | null {
  const { spam, caps, links } = filters;
  if (spam.enabled && hasRepeatRun(body, spam.maxRepeatedChars))
    return { kind: "spam", code: "msg_rejected", text: "Your message was not sent: too many repeated characters." };
  if (caps.enabled && isShouting(body, caps.minLength, caps.maxRatio))
    return { kind: "caps", code: "msg_rejected", text: "Your message was not sent: too many capital letters." };
  if (
    links.enabled &&
    !(links.allowSubscribers && standing.subscriberTier !== null) &&
    containsLink(body) &&
    !linksAllowlisted(body, normalizeAllowlist(links.allowlist))
  )
    return { kind: "links", code: "msg_links_blocked", text: "Links are not allowed in this channel." };
  return null;
}
