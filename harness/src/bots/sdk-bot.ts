// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SDK bot: a bot built on `@commonair/sdk` (ADR 0027 §5), so `e2e-social` exercises the SDK.
 * `BotSdk` is the surface a bot needs (typed API client + chat connection); `createContractSdk`
 * provides it with the SDK's `createClient` and `connectChat`. Answers the same commands as the
 * tmi.js bot.
 */
import type { Logger } from "@commonair/observability";
import { connectChat, createClient } from "@commonair/sdk";
import { type ApiClient, DEFAULT_USER_AGENT } from "../api/client.ts";
import { type BotReply } from "./tmi-bot.ts";
import { replyTo } from "./commands.ts";

/** One chat message as a bot sees it. */
export interface BotChatMessage {
  channel: string;
  id: string;
  userId: string;
  username: string;
  text: string;
}

export interface BotChatConnection {
  join(channel: string): Promise<void>;
  say(channel: string, text: string): Promise<void>;
  onMessage(handler: (m: BotChatMessage) => void): () => void;
  close(): void;
}

/** The surface a bot needs from an SDK; `createContractSdk` builds it on `@commonair/sdk`. */
export interface BotSdk {
  api: ApiClient;
  connectChat(): Promise<BotChatConnection>;
}

export interface ContractSdkOptions {
  apiUrl: string;
  /** Bot access token (from `me.bots.createToken`), scopes `chat:read chat:edit` at least. */
  token: string;
  /** Chat WebSocket URL; defaults to the URL `chat.connectToken` returns. */
  chatUrl?: string;
  log?: Logger;
}

/** `BotSdk` on `@commonair/sdk`: its typed client and its chat client (bearer on the upgrade). */
export function createContractSdk(opts: ContractSdkOptions): BotSdk {
  const api: ApiClient = createClient({
    baseUrl: opts.apiUrl,
    token: opts.token,
    headers: { "user-agent": DEFAULT_USER_AGENT },
  });
  return {
    api,
    async connectChat() {
      const chat = await connectChat({
        url: opts.chatUrl,
        client: api,
        token: opts.token,
        onError: (e) => opts.log?.warn("sdk chat frame dropped", { error: e.message }),
      });
      return {
        async join(channel) {
          await chat.join(channel);
        },
        async say(channel, text) {
          // Throws ChatError("rejected") when chat refuses it (an ack without an id, not held).
          await chat.say(channel, text);
        },
        onMessage(handler) {
          return chat.onMessage((m) =>
            handler({ channel: m.channel, id: m.id, userId: m.userId, username: m.username, text: m.text }),
          );
        },
        close: () => chat.close(),
      };
    },
  };
}

export interface SdkBotOptions {
  sdk: BotSdk;
  /** The bot's own user id, to ignore its own messages. */
  botUserId: string;
  channels: string[];
  log?: Logger;
}

export class SdkBot {
  readonly replies: BotReply[] = [];
  private chat: BotChatConnection | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly opts: SdkBotOptions) {}

  async start(): Promise<void> {
    const chat = await this.opts.sdk.connectChat();
    this.chat = chat;
    for (const channel of this.opts.channels) await chat.join(channel);
    this.off = chat.onMessage((m) => {
      if (m.userId === this.opts.botUserId) return;
      void this.handle(m);
    });
  }

  private async liveSince(channel: string): Promise<number | null> {
    try {
      const c = await this.opts.sdk.api.channels.get({ channel });
      return c.live ? Date.parse(c.live.startedAt) : null;
    } catch {
      return null;
    }
  }

  private async handle(m: BotChatMessage): Promise<void> {
    if (!m.text.trim().startsWith("!")) return;
    const reply = replyTo(m.text, { now: Date.now(), liveSince: await this.liveSince(m.channel) });
    if (reply === null || !this.chat) return;
    try {
      await this.chat.say(m.channel, reply);
      this.replies.push({ channel: m.channel, command: m.text.trim().split(/\s+/, 1)[0] ?? "", reply, at: Date.now() });
    } catch (err) {
      this.opts.log?.warn("sdk bot reply failed", { error: (err as Error).message });
    }
  }

  stop(): void {
    this.off?.();
    this.chat?.close();
    this.chat = null;
  }
}
