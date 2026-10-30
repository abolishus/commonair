// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a Discord go-live post says (ADR 0028 decision 5). Channel content posted to a third party,
 * built in English from this small server-side table like the chat service's notices: not the web
 * catalog. Pure.
 */

/** Discord's `content` limit, in characters. */
export const DISCORD_CONTENT_MAX = 2000;

const TEXT = {
  live: "{channel} is live: {title} {url}",
  liveMature: "{channel} is live (18+) {url}",
  liveUntitled: "{channel} is live {url}",
  test: "Test from {instance}: go-live posts for {channel} will appear here.",
} as const;

/** The JSON body of an `execute webhook` call. No username, avatar or embeds: only text. */
export interface DiscordMessage {
  content: string;
  /** Nothing in the text can ping: a title saying `@everyone` or `<@&role>` stays text. */
  allowed_mentions: { parse: [] };
}

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair; "…" marks the cut. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

const message = (content: string): DiscordMessage => ({
  content: cut(content, DISCORD_CONTENT_MAX),
  allowed_mentions: { parse: [] },
});

/**
 * A go-live post: "{channel} is live: {title} {url}". A mature broadcast or channel posts
 * "{channel} is live (18+) {url}" with no title (Discord is a public place). A long title is cut
 * so the link always fits; the channel name too when it alone would not leave room.
 */
export function goLiveMessage(p: { channel: string; title: string; url: string; mature: boolean }): DiscordMessage {
  const title = p.title.trim();
  if (p.mature || title === "") {
    const template = p.mature ? TEXT.liveMature : TEXT.liveUntitled;
    const room = DISCORD_CONTENT_MAX - fill(template, { channel: "", url: p.url }).length;
    return message(fill(template, { channel: cut(p.channel, room), url: p.url }));
  }
  const fixed = fill(TEXT.live, { channel: "", title: "", url: p.url }).length;
  const channel = cut(p.channel, Math.min(p.channel.length, Math.floor((DISCORD_CONTENT_MAX - fixed) / 2)));
  const room = DISCORD_CONTENT_MAX - fixed - channel.length;
  return message(fill(TEXT.live, { channel, title: cut(title, room), url: p.url }));
}

/** The studio's test post. */
export function testMessage(p: { instance: string; channel: string }): DiscordMessage {
  return message(fill(TEXT.test, p));
}
