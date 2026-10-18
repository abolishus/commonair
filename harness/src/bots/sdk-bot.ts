// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SDK bot. Written against `BotSdk`, a contract-level client interface (typed API client + chat
 * connection) so the implementation can be swapped for `@commonair/sdk` when it lands: the SDK
 * only has to satisfy `BotSdk` (or be adapted to it in `createContractSdk`). Answers the same
 * commands as the tmi.js bot.
 */
import type { Logger } from "@commonair/observability";
import { type ApiClient, createApi } from "../api/client.ts";
import { ChatClient } from "../chat-client.ts";
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

/** The surface a bot needs from an SDK. `@commonair/sdk` must provide (or adapt to) this. */
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

/** BotSdk built directly on the oRPC contract client and the chat protocol. */
export function createContractSdk(opts: ContractSdkOptions): BotSdk {
  const { client: api } = createApi({ baseUrl: opts.apiUrl, bearer: opts.token });
  return {
    api,
    async connectChat() {
      const url = opts.chatUrl ?? (await api.chat.connectToken()).url;
      const chat = await ChatClient.connect({ url, bearer: opts.token, log: opts.log });
      return {
        async join(channel) {
          await chat.join(channel);
        },
        async say(channel, text) {
          const ack = await chat.send(channel, text);
          if (ack.id === null && !ack.held) throw new Error("message rejected by chat");
        },
        onMessage(handler) {
          return chat.onFrame((f) => {
            if (f.op !== "message") return;
            handler({
              channel: f.channel,
              id: f.message.id,
              userId: f.message.user.id,
              username: f.message.user.username,
              text: f.message.body,
            });
          });
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
