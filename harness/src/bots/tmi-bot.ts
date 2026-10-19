// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A Twitch-style bot built on unmodified tmi.js 1.8.5, pointed at the IRC gateway's WebSocket
 * listener instead of Twitch. It answers `!ping` and `!uptime` exactly like the SDK bot, proving
 * existing Twitch bots migrate by changing only the host and token. It also records what it
 * observes (chat with tags, moderation events, notices) so scenarios can assert the Twitch
 * dialect end to end.
 */
import type { Logger } from "@commonair/observability";
import tmi, { type ChatUserstate, type Client } from "tmi.js";
import { waitFor } from "../wait.ts";
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
  /** When the triggering message arrived (ms epoch; tmi.js bot only). */
  receivedAt?: number;
  at: number;
}

/** A chat line the bot saw (its own lines included, flagged `self`). */
export interface ObservedMessage {
  channel: string;
  username: string;
  text: string;
  tags: ChatUserstate;
  self: boolean;
  at: number;
}

export type ModerationKind = "timeout" | "ban" | "clearchat" | "messagedeleted";

/** A moderation event as tmi.js reports it (CLEARCHAT → timeout/ban/clearchat, CLEARMSG → messagedeleted). */
export interface ModerationEvent {
  kind: ModerationKind;
  channel: string;
  /** Target user (null for a whole-room clear). */
  username: string | null;
  /** Timeout length in seconds (`ban-duration`), null otherwise. */
  durationSeconds: number | null;
  /** Deleted message id (`target-msg-id`), messagedeleted only. */
  messageId: string | null;
  tags: Record<string, unknown>;
  at: number;
}

export interface ObservedNotice {
  channel: string;
  msgId: string;
  text: string;
  at: number;
}

export interface WaitOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const bare = (channel: string) => channel.replace(/^#/, "").toLowerCase();

/** Records kept per list (like ChatClient's frame history), so a long run cannot grow unbounded. */
export const EVENT_LOG_LIMIT = 500;

function pushCapped<T>(list: T[], item: T, limit: number): void {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

/** The subset of a tmi.js client the event log listens to. */
export type TmiEventSource = Pick<Client, "on">;

/**
 * Everything a tmi.js client emitted that scenarios care about. Pure bookkeeping: `attach()` wires
 * it to a client, and tests can call the `on*` handlers directly.
 */
export class TmiEventLog {
  readonly messages: ObservedMessage[] = [];
  readonly moderation: ModerationEvent[] = [];
  readonly notices: ObservedNotice[] = [];
  readonly joined = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = EVENT_LOG_LIMIT,
  ) {}

  attach(client: TmiEventSource): this {
    client.on("message", (channel: string, tags: ChatUserstate, message: string, self: boolean) =>
      this.onMessage(channel, tags, message, self),
    );
    client.on("timeout", (channel: string, username: string, _reason: null, duration: number, tags: ChatUserstate) =>
      this.onTimeout(channel, username, duration, tags),
    );
    client.on("ban", (channel: string, username: string, _reason: null, tags: ChatUserstate) =>
      this.onBan(channel, username, tags),
    );
    client.on("clearchat", (channel: string) => this.onClearchat(channel));
    client.on("messagedeleted", (channel: string, username: string, _deleted: string, tags: ChatUserstate) =>
      this.onMessageDeleted(channel, username, tags),
    );
    client.on("notice", (channel: string, msgId: string, text: string) => this.onNotice(channel, msgId, text));
    client.on("join", (channel: string, _username: string, self: boolean) => {
      if (self) this.joined.add(bare(channel));
    });
    return this;
  }

  onMessage(channel: string, tags: ChatUserstate, text: string, self: boolean): ObservedMessage {
    const m: ObservedMessage = {
      channel: bare(channel),
      username: String(tags.username ?? "").toLowerCase(),
      text,
      tags,
      self,
      at: this.now(),
    };
    pushCapped(this.messages, m, this.limit);
    return m;
  }

  onTimeout(channel: string, username: string, duration: number, tags: Record<string, unknown> = {}): void {
    this.push("timeout", channel, username, { durationSeconds: duration, tags });
  }

  onBan(channel: string, username: string, tags: Record<string, unknown> = {}): void {
    this.push("ban", channel, username, { tags });
  }

  onClearchat(channel: string): void {
    this.push("clearchat", channel, null, {});
  }

  onMessageDeleted(channel: string, username: string, tags: Record<string, unknown> = {}): void {
    const id = tags["target-msg-id"];
    this.push("messagedeleted", channel, username, { tags, messageId: typeof id === "string" ? id : null });
  }

  onNotice(channel: string, msgId: string, text: string): void {
    pushCapped(this.notices, { channel: bare(channel), msgId, text, at: this.now() }, this.limit);
  }

  private push(
    kind: ModerationKind,
    channel: string,
    username: string | null,
    extra: { durationSeconds?: number; messageId?: string | null; tags?: Record<string, unknown> },
  ): void {
    pushCapped(
      this.moderation,
      {
        kind,
        channel: bare(channel),
        username: username === null ? null : username.toLowerCase(),
        durationSeconds: extra.durationSeconds ?? null,
        messageId: extra.messageId ?? null,
        tags: extra.tags ?? {},
        at: this.now(),
      },
      this.limit,
    );
  }

  /** Wait until a recorded (past or future) chat line matches. */
  waitForMessage(
    predicate: (m: ObservedMessage) => boolean,
    what = "chat message",
    opts: WaitOpts = {},
  ): Promise<ObservedMessage> {
    return waitFor(`tmi.js bot to see ${what}`, () => this.messages.find(predicate), {
      timeoutMs: opts.timeoutMs ?? 10_000,
      intervalMs: 25,
      signal: opts.signal,
    });
  }

  /** Wait until a recorded (past or future) moderation event matches. */
  waitForModeration(
    predicate: (e: ModerationEvent) => boolean,
    what = "moderation event",
    opts: WaitOpts = {},
  ): Promise<ModerationEvent> {
    return waitFor(`tmi.js bot to see ${what}`, () => this.moderation.find(predicate), {
      timeoutMs: opts.timeoutMs ?? 10_000,
      intervalMs: 25,
      signal: opts.signal,
    });
  }

  waitForJoin(channel: string, opts: WaitOpts = {}): Promise<true> {
    const c = bare(channel);
    return waitFor(`tmi.js bot to join #${c}`, () => this.joined.has(c) || null, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      intervalMs: 25,
      signal: opts.signal,
    });
  }
}

const NUMERIC = /^\d+$/;

/**
 * What is missing or malformed in a PRIVMSG's tags compared with Twitch's (as tmi.js parses
 * them). Empty means a Twitch bot would find everything it reads.
 */
export function twitchTagProblems(m: Pick<ObservedMessage, "tags" | "username">, expectUsername?: string): string[] {
  const t = m.tags;
  const problems: string[] = [];
  // tmi.js turns numeric-looking tag values into numbers (Twitch ids are numeric; ours are UUIDs).
  const str = (k: string) => {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  for (const k of ["id", "user-id", "room-id", "display-name"]) {
    if (!str(k)) problems.push(`${k} missing`);
  }
  const ts = str("tmi-sent-ts");
  if (!ts || !NUMERIC.test(ts)) problems.push("tmi-sent-ts missing or not numeric");
  if (t["message-type"] !== "chat") problems.push(`message-type is ${String(t["message-type"])}, expected chat`);
  if (expectUsername !== undefined && m.username !== expectUsername.toLowerCase())
    problems.push(`username is ${m.username}, expected ${expectUsername.toLowerCase()}`);
  for (const k of ["badges", "emotes", "mod", "subscriber", "turbo", "color", "user-type"]) {
    if (!(k in t)) problems.push(`${k} missing`);
  }
  return problems;
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
  readonly events = new TmiEventLog();
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
    this.events.attach(this.client);
    this.client.on("message", (channel, _tags, message, self) => {
      if (self) return;
      void this.handle(channel, message, Date.now());
    });
  }

  get username(): string {
    return this.opts.username.toLowerCase();
  }

  private async handle(channel: string, message: string, receivedAt: number): Promise<void> {
    const name = channel.replace(/^#/, "");
    const liveSince = (await this.opts.liveSince?.(name)) ?? null;
    const reply = replyTo(message, { now: Date.now(), liveSince });
    if (reply === null) return;
    try {
      await this.client.say(channel, reply);
      this.replies.push({
        channel: name,
        command: message.trim().split(/\s+/, 1)[0] ?? "",
        reply,
        receivedAt,
        at: Date.now(),
      });
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
