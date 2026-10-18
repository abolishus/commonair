// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat command parsing, shared by `{op:"command"}` frames and chat text starting with "/".
 * Parsing is pure; authorization and effects live in `moderation.ts`.
 */
import { CHAT_LIMITS } from "@commonair/contracts";

export const MAX_TIMEOUT_SECONDS = 1_209_600;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_SLOW_SECONDS = 30;
/** Mirrors the bounds of ChannelChatSettings.slowModeSeconds / followersOnlyMinutes. */
const MAX_SLOW_SECONDS = 600;
const MAX_FOLLOWER_MINUTES = 129_600;

export type Command =
  | { kind: "ban"; target: string; reason: string }
  | { kind: "unban"; target: string }
  | { kind: "timeout"; target: string; seconds: number; reason: string }
  | { kind: "untimeout"; target: string }
  | { kind: "delete"; messageId: string }
  | { kind: "clear" }
  | { kind: "slow"; seconds: number }
  | { kind: "slowoff" }
  | { kind: "followers"; minutes: number }
  | { kind: "followersoff" }
  | { kind: "subscribers" }
  | { kind: "subscribersoff" }
  | { kind: "emoteonly" }
  | { kind: "emoteonlyoff" }
  | { kind: "mod" | "unmod" | "vip" | "unvip"; target: string }
  | { kind: "me"; text: string };

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; code: "usage" | "unrecognized_cmd"; text: string };

const USERNAME = /^[a-z0-9_]{3,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATION = /^(\d{1,9})([smhdw]?)$/i;
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** "600", "10m", "1h", "2d", "1w" → seconds; `defaultUnit` applies to bare numbers. */
export function parseDuration(raw: string, defaultUnit: "s" | "m" = "s"): number | null {
  const m = DURATION.exec(raw.trim());
  if (!m) return null;
  const unit = (m[2] ?? "").toLowerCase() || defaultUnit;
  const value = Number(m[1]) * (UNIT_SECONDS[unit] ?? 1);
  return Number.isSafeInteger(value) ? value : null;
}

/** "@Name" → "name"; null when it cannot be a username. */
export function normalizeUsername(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/^@/, "").toLowerCase();
  return USERNAME.test(name) ? name : null;
}

/** Split "/timeout bob 60 spam" into a command name and args; null when it is not a command. */
export function splitChatCommand(text: string): { name: string; args: string[] } | null {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const [head, ...args] = text.slice(1).trim().split(/\s+/u);
  if (!head) return null;
  return { name: head.toLowerCase(), args };
}

const usage = (text: string): ParseResult => ({ ok: false, code: "usage", text: `Usage: ${text}` });

const withTarget = (args: string[], syntax: string, build: (target: string) => Command): ParseResult => {
  const target = normalizeUsername(args[0]);
  return target ? { ok: true, command: build(target) } : usage(syntax);
};

export function parseCommand(name: string, args: readonly string[]): ParseResult {
  const a = [...args];
  switch (name) {
    case "ban":
      return withTarget(a, "/ban <username> [reason]", (target) => ({
        kind: "ban",
        target,
        reason: a.slice(1).join(" ").slice(0, CHAT_LIMITS.maxBodyLength),
      }));
    case "unban":
    case "untimeout":
      return withTarget(a, `/${name} <username>`, (target) => ({ kind: name, target }));
    case "timeout": {
      const target = normalizeUsername(a[0]);
      if (!target) return usage("/timeout <username> [duration] [reason]");
      let seconds = DEFAULT_TIMEOUT_SECONDS;
      let rest = a.slice(1);
      const parsed = a[1] === undefined ? null : parseDuration(a[1]);
      if (parsed !== null) {
        seconds = parsed;
        rest = a.slice(2);
      }
      if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS)
        return usage(`/timeout <username> [1-${MAX_TIMEOUT_SECONDS} seconds] [reason]`);
      return {
        ok: true,
        command: { kind: "timeout", target, seconds, reason: rest.join(" ").slice(0, CHAT_LIMITS.maxBodyLength) },
      };
    }
    case "delete": {
      const id = a[0];
      return id && UUID.test(id)
        ? { ok: true, command: { kind: "delete", messageId: id.toLowerCase() } }
        : usage("/delete <message id>");
    }
    case "clear":
    case "slowoff":
    case "followersoff":
    case "subscribers":
    case "subscribersoff":
    case "emoteonly":
    case "emoteonlyoff":
      return { ok: true, command: { kind: name } };
    case "slow": {
      const seconds = a[0] === undefined ? DEFAULT_SLOW_SECONDS : parseDuration(a[0]);
      if (seconds === null || seconds < 1 || seconds > MAX_SLOW_SECONDS)
        return usage(`/slow [1-${MAX_SLOW_SECONDS} seconds]`);
      return { ok: true, command: { kind: "slow", seconds } };
    }
    case "followers": {
      const seconds = a[0] === undefined ? 0 : parseDuration(a[0], "m");
      const minutes = seconds === null ? null : Math.floor(seconds / 60);
      if (minutes === null || minutes > MAX_FOLLOWER_MINUTES) return usage("/followers [duration, e.g. 10m, 1h, 1w]");
      return { ok: true, command: { kind: "followers", minutes } };
    }
    case "mod":
    case "unmod":
    case "vip":
    case "unvip":
      return withTarget(a, `/${name} <username>`, (target) => ({ kind: name, target }));
    case "me": {
      const text = a.join(" ").trim();
      return text ? { ok: true, command: { kind: "me", text } } : usage("/me <text>");
    }
    default:
      return { ok: false, code: "unrecognized_cmd", text: `Unrecognized command: /${name}` };
  }
}
