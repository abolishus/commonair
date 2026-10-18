// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A Twitch-style bot built on unmodified tmi.js 1.8.5, pointed at the IRC gateway's WebSocket
 * listener instead of Twitch. It answers `!ping` and `!uptime` exactly like the SDK bot, proving
 * existing Twitch bots migrate by changing only the host and token.
 */
import type { Logger } from "@commonair/observability";
import tmi, { type Client } from "tmi.js";
import { replyTo } from "./commands.ts";

export interface TmiBotOptions {
  /** IRC gateway WebSocket URL, e.g. `ws://localhost:6680`. */
  url: string;
  username: string;
  /** OAuth access token (sent as `PASS oauth:<token>`). */
  token: string;
  channels: string[];
  /** Broadcast start for `!uptime` (null = offline). */
  liveSince?: (channel: string) => Promise<number | null> | number | null;
  log?: Logger;
}

export interface BotReply {
  channel: string;
  command: string;
  reply: string;
  at: number;
}

/** Parse `ws://host:port` into tmi.js connection settings. */
export function tmiConnection(url: string): { server: string; port: number; secure: boolean } {
  const u = new URL(url);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error("tmi.js needs a ws:// or wss:// URL");
  const secure = u.protocol === "wss:";
  return { server: u.hostname, port: u.port ? Number(u.port) : secure ? 443 : 80, secure };
}

export class TmiBot {
  readonly replies: BotReply[] = [];
  private readonly client: Client;

  constructor(private readonly opts: TmiBotOptions) {
    this.client = new tmi.Client({
      // Never call Twitch's HTTP API for emote sets: the harness must not touch third parties.
      options: { debug: false, skipUpdatingEmotesets: true },
      connection: { ...tmiConnection(opts.url), reconnect: false, timeout: 10_000 },
      identity: { username: opts.username, password: `oauth:${opts.token}` },
      channels: opts.channels.map((c) => `#${c.replace(/^#/, "")}`),
      logger: {
        info: (msg) => opts.log?.debug("tmi.js", { msg }),
        warn: (msg) => opts.log?.warn("tmi.js", { msg }),
        error: (msg) => opts.log?.error("tmi.js", { msg }),
      },
    });
    this.client.on("message", (channel, _tags, message, self) => {
      if (self) return;
      void this.handle(channel, message);
    });
  }

  private async handle(channel: string, message: string): Promise<void> {
    const name = channel.replace(/^#/, "");
    const liveSince = (await this.opts.liveSince?.(name)) ?? null;
    const reply = replyTo(message, { now: Date.now(), liveSince });
    if (reply === null) return;
    try {
      await this.client.say(channel, reply);
      this.replies.push({ channel: name, command: message.trim().split(/\s+/, 1)[0] ?? "", reply, at: Date.now() });
    } catch (err) {
      this.opts.log?.warn("tmi bot reply failed", { error: String(err) });
    }
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async say(channel: string, message: string): Promise<void> {
    await this.client.say(`#${channel.replace(/^#/, "")}`, message);
  }

  async disconnect(): Promise<void> {
    if (this.client.readyState() === "OPEN") await this.client.disconnect().catch(() => undefined);
  }
}
