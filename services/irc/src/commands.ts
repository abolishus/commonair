// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Translation of PRIVMSG text into upstream frames. Plain text (including
 * `!bot` commands) becomes `send`; CTCP ACTION and `/me` become an action;
 * Twitch chat commands (`/ban`, `.timeout`, …) become `command` frames.
 * Authorization is not checked here: upstream decides and answers with a notice.
 */
import { CHAT_LIMITS } from "@commonair/contracts";

export type Translation =
  | { kind: "send"; body: string; isAction: boolean }
  | { kind: "command"; command: string; args: string[] }
  | { kind: "notice"; msgId: string; text: string }
  | { kind: "ignore" };

interface CommandSpec {
  /** Upstream command name. */
  upstream: string;
  /** Builds upstream args, or returns null for a usage error. */
  args: (argv: string[]) => string[] | null;
  usage: string;
}

const MAX_ARGS = 10;
const MAX_ARG_LENGTH = 500;

const login = (s: string | undefined): string | null => {
  const v = s?.replace(/^@/, "").toLowerCase();
  return v && /^[a-z0-9_]{1,25}$/.test(v) ? v : null;
};
const rest = (argv: string[], from: number): string[] => {
  const r = argv.slice(from).join(" ").trim();
  return r ? [r] : [];
};

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
  w: 604_800,
  week: 604_800,
  weeks: 604_800,
  mo: 2_592_000,
  month: 2_592_000,
  months: 2_592_000,
};

/**
 * Twitch durations: a bare number (in `unit`) or a number with a unit
 * (`10m`, `1h`, `30 minutes`, `2 weeks`). Returns seconds, or null if unparsable.
 */
export function parseDuration(raw: string, unit: "seconds" | "minutes" = "seconds"): number | null {
  const m = /^(\d+)\s*([a-z]*)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const suffix = (m[2] ?? "").toLowerCase();
  const per = suffix === "" ? (unit === "minutes" ? 60 : 1) : UNIT_SECONDS[suffix];
  if (per === undefined) return null;
  const seconds = n * per;
  return Number.isSafeInteger(seconds) ? seconds : null;
}

const userOnly: CommandSpec["args"] = (argv) => {
  const u = login(argv[0]);
  return u ? [u] : null;
};

/** Twitch chat command (without the leading `/` or `.`) → upstream command. */
export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  ban: {
    upstream: "ban",
    usage: "Usage: /ban <username> [reason]",
    args: (argv) => {
      const u = login(argv[0]);
      return u ? [u, ...rest(argv, 1)] : null;
    },
  },
  unban: { upstream: "unban", usage: "Usage: /unban <username>", args: userOnly },
  timeout: {
    upstream: "timeout",
    usage: "Usage: /timeout <username> [duration] [reason]",
    args: (argv) => {
      const u = login(argv[0]);
      if (!u) return null;
      if (argv[1] === undefined) return [u];
      const secs = parseDuration(argv[1]);
      // Twitch treats a non-duration second word as the start of the reason.
      if (secs === null) return [u, "600", ...rest(argv, 1)];
      if (secs < 1 || secs > 1_209_600) return null;
      return [u, String(secs), ...rest(argv, 2)];
    },
  },
  untimeout: { upstream: "untimeout", usage: "Usage: /untimeout <username>", args: userOnly },
  delete: {
    upstream: "delete",
    usage: "Usage: /delete <msg id>",
    args: (argv) => (argv[0] && /^[0-9a-f-]{36}$/i.test(argv[0]) ? [argv[0].toLowerCase()] : null),
  },
  clear: { upstream: "clear", usage: "Usage: /clear", args: () => [] },
  slow: {
    upstream: "slow",
    usage: "Usage: /slow [duration]",
    args: (argv) => {
      if (argv[0] === undefined) return [];
      const secs = parseDuration(argv[0]);
      return secs !== null && secs >= 1 && secs <= 600 ? [String(secs)] : null;
    },
  },
  slowoff: { upstream: "slowoff", usage: "Usage: /slowoff", args: () => [] },
  followers: {
    upstream: "followers",
    usage: "Usage: /followers [duration]",
    args: (argv) => {
      if (argv[0] === undefined) return [];
      const secs = parseDuration(argv.join(" "), "minutes");
      return secs !== null && secs <= 129_600 * 60 ? [String(Math.floor(secs / 60))] : null;
    },
  },
  followersoff: { upstream: "followersoff", usage: "Usage: /followersoff", args: () => [] },
  subscribers: { upstream: "subscribers", usage: "Usage: /subscribers", args: () => [] },
  subscribersoff: { upstream: "subscribersoff", usage: "Usage: /subscribersoff", args: () => [] },
  emoteonly: { upstream: "emoteonly", usage: "Usage: /emoteonly", args: () => [] },
  emoteonlyoff: { upstream: "emoteonlyoff", usage: "Usage: /emoteonlyoff", args: () => [] },
  mod: { upstream: "mod", usage: "Usage: /mod <username>", args: userOnly },
  unmod: { upstream: "unmod", usage: "Usage: /unmod <username>", args: userOnly },
  vip: { upstream: "vip", usage: "Usage: /vip <username>", args: userOnly },
  unvip: { upstream: "unvip", usage: "Usage: /unvip <username>", args: userOnly },
};

/** Twitch aliases for the same commands. */
const ALIASES: Readonly<Record<string, string>> = {
  subs: "subscribers",
  subsoff: "subscribersoff",
  followersonly: "followers",
  followersonlyoff: "followersoff",
  emoteonlyon: "emoteonly",
};

/** Twitch's usage msg-ids are `usage_<command>` with a few special cases. */
const USAGE_MSG_IDS: Readonly<Record<string, string>> = {
  slow: "usage_slow_on",
  slowoff: "usage_slow_off",
  followers: "usage_followers_on",
  followersoff: "usage_followers_off",
  subscribers: "usage_subs_on",
  subscribersoff: "usage_subs_off",
  emoteonly: "usage_emote_only_on",
  emoteonlyoff: "usage_emote_only_off",
};

const CTCP = "\u0001";

/** CTCP ACTION body (`\x01ACTION text\x01`, closing delimiter optional as many clients omit it), or null. */
function actionBody(text: string): string | null {
  const head = `${CTCP}ACTION`;
  if (!text.startsWith(head)) return null;
  let rest = text.slice(head.length);
  if (rest.endsWith(CTCP)) rest = rest.slice(0, -1);
  if (rest === "") return "";
  return rest.startsWith(" ") ? rest.slice(1) : null;
}

export function translatePrivmsg(text: string): Translation {
  const action = actionBody(text);
  if (action !== null) return sendOf(action, true);
  if (text.startsWith(CTCP)) return { kind: "ignore" }; // other CTCP (VERSION, PING): Twitch drops them

  const cmd = /^([/.])([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/s.exec(text);
  if (!cmd) return sendOf(text, false);
  const [, sigil, rawName = "", argText = ""] = cmd;
  const name = rawName.toLowerCase();

  if (name === "me") {
    if (argText.trim() === "") return { kind: "notice", msgId: "usage_me", text: "Usage: /me <message>" };
    return sendOf(argText, true);
  }
  const spec = COMMANDS[ALIASES[name] ?? name];
  if (!spec) {
    // `.word` that is not a command is ordinary chat ("…ok", ".net is nice"); `/word` is always a command.
    if (sigil === ".") return sendOf(text, false);
    return { kind: "notice", msgId: "unrecognized_cmd", text: `Unrecognized command: /${name}` };
  }
  const argv = argText.split(/\s+/).filter(Boolean);
  const args = spec.args(argv);
  const canonical = ALIASES[name] ?? name;
  if (args === null || args.length > MAX_ARGS)
    return { kind: "notice", msgId: USAGE_MSG_IDS[canonical] ?? `usage_${canonical}`, text: spec.usage };
  return { kind: "command", command: spec.upstream, args: args.map((a) => a.slice(0, MAX_ARG_LENGTH)) };
}

function sendOf(body: string, isAction: boolean): Translation {
  const trimmed = truncateUtf16(body, CHAT_LIMITS.maxBodyLength);
  if (trimmed.trim() === "") return { kind: "ignore" };
  return { kind: "send", body: trimmed, isAction };
}

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return s.slice(0, cut);
}
