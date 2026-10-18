// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * IRC message model, parser and serializer (RFC 1459 framing + IRCv3 message tags).
 *
 *   [@tag=value;tag2 ][:prefix ]COMMAND [param ...][ :trailing]
 */

/** A tag without `=` is a flag; it is represented by the empty string, as IRCv3 says they are equivalent. */
export type Tags = Record<string, string>;

export interface IrcMessage {
  tags: Tags;
  prefix: string | null;
  command: string;
  /** Middle params followed by the trailing param, if any. */
  params: string[];
  /** True when the last param was written with a leading `:` (lets callers tell `:x` from `x`). */
  hasTrailing: boolean;
}

/** Outgoing message; `trailing` is always written with a leading `:` (as Twitch does for PRIVMSG text). */
export interface OutgoingMessage {
  tags?: Tags | undefined;
  prefix?: string | undefined;
  command: string;
  params?: string[];
  trailing?: string | undefined;
}

const TAG_ESCAPES: Record<string, string> = { ";": "\\:", " ": "\\s", "\\": "\\\\", "\r": "\\r", "\n": "\\n" };
const TAG_UNESCAPES: Record<string, string> = { ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" };

export function escapeTagValue(value: string): string {
  return value.replace(/[; \\\r\n]/g, (c) => TAG_ESCAPES[c] ?? c);
}

/** IRCv3: unknown escapes drop the backslash; a trailing lone backslash is dropped. */
export function unescapeTagValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = value[i + 1];
    i++;
    if (next === undefined) break;
    out += TAG_UNESCAPES[next] ?? next;
  }
  return out;
}

function parseTags(raw: string): Tags {
  const tags: Tags = {};
  for (const part of raw.split(";")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) tags[part] = "";
    else tags[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
  }
  return tags;
}

/** Parse one line (without CR/LF). Returns null for empty or malformed lines. */
export function parseMessage(line: string): IrcMessage | null {
  let rest = line.replace(/[\r\n]+$/, "");
  let tags: Tags = {};
  let prefix: string | null = null;

  rest = rest.replace(/^ +/, "");
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }

  const params: string[] = [];
  let hasTrailing = false;
  let command = "";
  while (rest.length > 0) {
    if (command !== "" && rest.startsWith(":")) {
      params.push(rest.slice(1));
      hasTrailing = true;
      break;
    }
    const sp = rest.indexOf(" ");
    const token = sp === -1 ? rest : rest.slice(0, sp);
    if (command === "") command = token;
    else params.push(token);
    rest = sp === -1 ? "" : rest.slice(sp + 1).replace(/^ +/, "");
  }
  if (command === "" || !/^([A-Za-z]+|\d{3})$/.test(command)) return null;
  return { tags, prefix, command: command.toUpperCase(), params, hasTrailing };
}

/** Empty values are written as `key=` (not a bare flag), exactly as Twitch writes `badges=;color=`. */
export function serializeTags(tags: Tags): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${escapeTagValue(v)}`)
    .join(";");
}

/** Serialize one message without CRLF. Middle params must not contain spaces or start with `:`. */
export function serializeMessage(msg: OutgoingMessage): string {
  let out = "";
  if (msg.tags && Object.keys(msg.tags).length > 0) out += `@${serializeTags(msg.tags)} `;
  if (msg.prefix) out += `:${msg.prefix} `;
  out += msg.command;
  for (const p of msg.params ?? []) {
    if (p === "" || p.includes(" ") || p.startsWith(":"))
      throw new Error(`invalid middle IRC param ${JSON.stringify(p)}`);
    out += ` ${p}`;
  }
  // CR/LF/NUL in a trailing param would inject a second line: strip them.
  if (msg.trailing !== undefined) out += ` :${msg.trailing.replace(/[\r\n\0]/g, " ")}`;
  return out;
}
