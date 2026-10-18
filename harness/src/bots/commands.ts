// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The command set every harness bot answers, whatever transport it uses (chat WebSocket via the
 * SDK-style client, or Twitch IRC via tmi.js), so scenarios can assert identical behaviour.
 */

export const BOT_REPLIES = { ping: "pong" } as const;

export interface CommandContext {
  now: number;
  /** When the channel's broadcast started (stream uptime), or null when offline. */
  liveSince: number | null;
}

/** Format a duration like Twitch bots do: `1h 2m 3s`, `4m 0s`, `12s`. */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Reply text for a chat message, or null when it is not a command this bot handles. */
export function replyTo(text: string, ctx: CommandContext): string | null {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  switch (command) {
    case "!ping":
      return BOT_REPLIES.ping;
    case "!uptime":
      return ctx.liveSince === null ? "offline" : `live for ${formatUptime(ctx.now - ctx.liveSince)}`;
    default:
      return null;
  }
}
