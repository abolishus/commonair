// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Parsing chat text for the bot: `!name args…` and song request links. Pure. */
import { BOT_BUILTIN_COMMANDS } from "@commonair/contracts/enums";

export type BuiltinCommand = (typeof BOT_BUILTIN_COMMANDS)[number];

/** The API's command-name rule (`BotCommand.name`). */
const NAME = /^[a-z0-9_]{1,25}$/;
/** Arguments the bot looks at; the rest of a long message is ignored. */
const MAX_ARGS = 10;

export interface BangCommand {
  name: string;
  args: string[];
}

/** "!Hello @bob extra" → { name: "hello", args: ["@bob", "extra"] }; null when not a bot command. */
export function parseBang(body: string): BangCommand | null {
  if (!body.startsWith("!")) return null;
  const parts = body.slice(1).split(/\s+/u, MAX_ARGS + 1);
  const head = parts[0]?.toLowerCase() ?? "";
  if (!NAME.test(head)) return null;
  return { name: head, args: parts.slice(1).filter((a) => a.length > 0) };
}

const BUILTINS: ReadonlySet<string> = new Set(BOT_BUILTIN_COMMANDS);
export const isBuiltin = (name: string): name is BuiltinCommand => BUILTINS.has(name);

export interface Named {
  name: string;
  aliases: readonly string[];
}

/**
 * Index commands by name, then by alias: a name always wins over another command's alias, and
 * the first command to claim an alias keeps it. Built-in names are never indexed (the API refuses
 * them; this keeps an old row from shadowing one).
 */
export function indexCommands<T extends Named>(commands: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const c of commands) if (!isBuiltin(c.name)) out.set(c.name, c);
  for (const c of commands) for (const alias of c.aliases) if (!isBuiltin(alias) && !out.has(alias)) out.set(alias, c);
  return out;
}

export type Resolved<T> = { kind: "builtin"; name: BuiltinCommand } | { kind: "custom"; command: T } | null;

/** A built-in first, then a command name, then an alias. */
export function resolveCommand<T>(name: string, index: ReadonlyMap<string, T>): Resolved<T> {
  if (isBuiltin(name)) return { kind: "builtin", name };
  const command = index.get(name);
  return command ? { kind: "custom", command } : null;
}

/** `${touser}`: the first argument without a leading "@", cut to a username's length. */
export function toUser(args: readonly string[]): string | null {
  const first = args[0]?.replace(/^@+/, "");
  return first ? first.slice(0, 25) : null;
}

export const SONG_URL_MAX = 500;

/**
 * A song request link: an http(s) URL that parses, at most 500 characters, without credentials,
 * whose host has a dot. Returns the URL as typed (never fetched, ADR 0026 decision 6), else null.
 */
export function acceptSongUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > SONG_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  return raw;
}
