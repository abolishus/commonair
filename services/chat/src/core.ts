// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat behaviour independent of the transport: sending (pipeline → persist → fan-out →
 * event bus → plugin hooks), commands, joins, and the handlers for messages arriving from
 * Valkey. `server.ts` wires it to Bun's WebSocket server.
 */
import { and, eq, isNull } from "drizzle-orm";
import { BusEvent, type dto, type ServerFrame } from "@commonair/contracts";
import { schema, uuidv7, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { badgesFor, colorFor } from "./badges.ts";
import type { Bus } from "./bus.ts";
import { parseCommand } from "./commands.ts";
import { ChatControlMessage, type ChatFanout, parseJson } from "./control.ts";
import type { Directory } from "./directory.ts";
import { chatMessageEvent, isInlineEvent } from "./events.ts";
import type { Limiter } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import { MODERATE_SCOPE, type Moderation } from "./moderation.ts";
import { canModerate, rankOf } from "./permissions.ts";
import { dbErrorFields, type MessageWriter } from "./persistence.ts";
import { type MessageContext, type MessageMiddleware, runSendPipeline } from "./pipeline.ts";
import type { Audience, Rooms } from "./rooms.ts";
import { canChatHint } from "./rules.ts";
import { type ChatSocket, sendFrame, type Writer } from "./socket.ts";
import {
  type ChannelState,
  type Identity,
  NO_STANDING,
  type Rejection,
  type Standing,
  type UserProfile,
} from "./types.ts";

export interface SendInput {
  channel: string;
  body: string;
  isAction: boolean;
  replyToId: string | null;
}

export interface SendOutcome {
  id: string | null;
  held: boolean;
  notice: Rejection | null;
}

export interface CoreDeps {
  db: Database;
  bus: Bus;
  rooms: Rooms;
  directory: Directory;
  limiter: Limiter;
  writer: MessageWriter;
  moderation: Moderation;
  middlewares: readonly MessageMiddleware[];
  metrics: Metrics;
  logger: Logger;
  frameWriter: Writer;
  maxRoomsPerConnection: number;
}

const noChannel: Rejection = { code: "msg_rejected", text: "No such channel." };

export class ChatCore {
  constructor(private readonly d: CoreDeps) {}

  // ── sending ────────────────────────────────────────────────────────────────

  async submit(identity: Identity, input: SendInput, opts: { skipMiddleware?: boolean } = {}): Promise<SendOutcome> {
    const receivedAt = new Date();
    const messageId = uuidv7(receivedAt.getTime());
    const loaded = await this.d.directory.channel(input.channel);
    if (!loaded) return { id: null, held: false, notice: noChannel };
    const channel = loaded.state;
    const user = identity.userId ? await this.d.directory.profile(identity.userId) : null;
    const standing = user ? await this.d.directory.standing(channel, user.id) : NO_STANDING;
    const result = await runSendPipeline(
      { limiter: this.d.limiter, middlewares: opts.skipMiddleware ? [] : this.d.middlewares },
      {
        messageId,
        receivedAt,
        user,
        scopes: identity.scopes,
        viaAppId: identity.appId,
        channel,
        filters: loaded.filters,
        standing,
        body: input.body,
        isAction: input.isAction,
        replyToId: input.replyToId,
        logger: this.d.logger,
      },
    );
    if (!result.ok) {
      this.d.metrics.dropped("rejected", { code: result.rejection.code });
      return { id: null, held: false, notice: result.rejection };
    }
    // The pipeline only accepts messages from a logged-in user.
    const author = result.ctx.user;
    const replyTo = input.replyToId ? await this.lookupReply(channel.id, input.replyToId) : null;
    const message: dto.ChatMessage = {
      id: messageId,
      channelId: channel.id,
      user: {
        id: author.id,
        username: author.username,
        displayName: author.displayName,
        color: colorFor(author.id),
        badges: badgesFor(author, standing),
        accountType: author.accountType,
      },
      body: result.body,
      emotes: result.emotes,
      isAction: input.isAction,
      replyTo,
      createdAt: receivedAt.toISOString(),
    };
    // Acked right away with the id minted above; the row is committed within one flush interval.
    this.d.writer.enqueue({
      id: messageId,
      channelId: channel.id,
      broadcastId: channel.liveBroadcastId,
      userId: author.id,
      body: result.body,
      emotes: result.emotes,
      isAction: input.isAction,
      replyToId: replyTo?.id ?? null,
      viaAppId: identity.appId,
      heldAt: result.held ? receivedAt : null,
      createdAt: receivedAt,
    });
    if (result.held) {
      await this.fanout(channel.id, { op: "message", channel: channel.slug, message, held: true }, "moderators");
      return {
        id: messageId,
        held: true,
        notice: { code: "msg_held", text: "Your message is being held for review by moderators." },
      };
    }
    await this.fanout(channel.id, { op: "message", channel: channel.slug, message }, "all");
    await this.publishEvent(chatMessageEvent(channel, message));
    this.runHooks(result.ctx, message);
    return { id: messageId, held: false, notice: null };
  }

  private async fanout(channelId: string, frame: ServerFrame, audience: Audience): Promise<void> {
    const envelope: ChatFanout = { v: 1, audience, sentAt: Date.now(), frame };
    try {
      await this.d.bus.publish(this.d.bus.names.chat(channelId), JSON.stringify(envelope));
    } catch (err) {
      // Persisted but not delivered live; late joiners still see it in history.
      this.d.logger.error("chat fan-out publish failed", { err, channelId });
    }
  }

  private async publishEvent(event: BusEvent): Promise<void> {
    try {
      await this.d.bus.publish(this.d.bus.names.events(), JSON.stringify(event));
    } catch (err) {
      this.d.logger.error("chat event publish failed", { err, channelId: event.channelId });
    }
  }

  private runHooks(ctx: MessageContext, message: dto.ChatMessage): void {
    for (const mw of this.d.middlewares) {
      if (!mw.onMessage) continue;
      mw.onMessage(ctx, message).catch((err: unknown) =>
        this.d.logger.error("chat middleware onMessage failed", { err, middleware: mw.name }),
      );
    }
  }

  private async lookupReply(channelId: string, id: string): Promise<dto.ChatMessage["replyTo"]> {
    const recent = this.d.rooms.get(channelId)?.recent.get(id);
    if (recent) return { id, username: recent.username, body: recent.body };
    const m = schema.chatMessages;
    const [row] = await this.d.db
      .select({ id: m.id, body: m.body, username: schema.users.username })
      .from(m)
      .innerJoin(schema.users, eq(schema.users.id, m.userId))
      .where(and(eq(m.id, id), eq(m.channelId, channelId), isNull(m.deletedAt), isNull(m.heldAt)))
      .limit(1);
    return row ? { id: row.id, username: row.username, body: row.body } : null;
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /** Run a command. Always yields exactly one notice for the caller (the IRC gateway relies on it). */
  async command(identity: Identity, slug: string, name: string, args: readonly string[]): Promise<Rejection> {
    const parsed = parseCommand(name, args);
    if (!parsed.ok) return { code: parsed.code, text: parsed.text };
    const cmd = parsed.command;
    if (cmd.kind === "me") {
      const r = await this.submit(identity, { channel: slug, body: cmd.text, isAction: true, replyToId: null });
      return r.notice ?? { code: "cmd_success", text: "Message sent." };
    }
    if (!identity.userId) return { code: "msg_requires_login", text: "You must be logged in to use commands." };
    const loaded = await this.d.directory.channel(slug);
    if (!loaded) return noChannel;
    const user = await this.d.directory.profile(identity.userId);
    if (!user) return { code: "msg_requires_login", text: "You must be logged in to use commands." };
    const standing = await this.d.directory.standing(loaded.state, user.id);
    try {
      return await this.d.moderation.execute({ user, standing, scopes: identity.scopes }, loaded.state, cmd);
    } catch (err) {
      this.d.logger.error("chat command failed", {
        ...dbErrorFields(err),
        command: cmd.kind,
        channelId: loaded.state.id,
      });
      return { code: "msg_rejected", text: "The command failed. Try again." };
    }
  }

  // ── rooms ──────────────────────────────────────────────────────────────────

  private moderatorView(identity: Identity, standing: Standing): boolean {
    return identity.userId !== null && canModerate(rankOf(standing)) && identity.scopes.includes(MODERATE_SCOPE);
  }

  /** Join a room and send `joined`; returns the error to report (with the request's nonce) on failure. */
  async join(ws: ChatSocket, slug: string): Promise<{ code: string; message: string } | null> {
    const data = ws.data;
    const w = this.d.frameWriter;
    if (!data.rooms.has(slug) && data.rooms.size >= this.d.maxRoomsPerConnection)
      return { code: "too_many_rooms", message: `At most ${this.d.maxRoomsPerConnection} rooms per connection.` };
    const loaded = await this.d.directory.channel(slug);
    if (!loaded) return { code: "channel_not_found", message: `No channel named ${slug}.` };
    const ch = loaded.state;
    const user = data.identity.userId ? await this.d.directory.profile(data.identity.userId) : null;
    const standing = user ? await this.d.directory.standing(ch, user.id) : NO_STANDING;
    const canMod = this.moderatorView(data.identity, standing);
    await this.d.rooms.join(ws, ch, {
      canModerate: canMod,
      userId: user?.id ?? null,
      modScope: data.identity.scopes.includes(MODERATE_SCOPE),
    });
    if (data.closed) {
      await this.d.rooms.part(ws, ch.id);
      return null;
    }
    data.rooms.set(ch.slug, ch.id);
    sendFrame(ws, this.joinedFrame(ch, user, standing, data.identity, canMod), w);
    return null;
  }

  private joinedFrame(
    ch: ChannelState,
    user: UserProfile | null,
    standing: Standing,
    identity: Identity,
    canMod: boolean,
  ): ServerFrame {
    return {
      op: "joined",
      channel: ch.slug,
      channelId: ch.id,
      settings: ch.settings,
      me: {
        // "type" or "type/tier" (e.g. "subscriber/2"), the IRC badge-tag shape.
        badges: user
          ? badgesFor(user, standing).map((b) => (b.tier === undefined ? b.type : `${b.type}/${b.tier}`))
          : [],
        canModerate: canMod,
        canChat: canChatHint(user, identity.scopes, ch, standing, new Date()),
      },
    };
  }

  async part(ws: ChatSocket, slug: string): Promise<void> {
    const channelId = ws.data.rooms.get(slug);
    if (channelId) {
      ws.data.rooms.delete(slug);
      await this.d.rooms.part(ws, channelId);
    }
    sendFrame(ws, { op: "parted", channel: slug }, this.d.frameWriter);
  }

  async partAll(ws: ChatSocket): Promise<void> {
    const ids = [...ws.data.rooms.values()];
    ws.data.rooms.clear();
    await Promise.all(ids.map((id) => this.d.rooms.part(ws, id)));
  }

  // ── bus handlers ───────────────────────────────────────────────────────────

  onChat(channelId: string, raw: string): void {
    let env: Partial<ChatFanout>;
    try {
      env = JSON.parse(raw) as Partial<ChatFanout>;
    } catch {
      return;
    }
    // Our own publishers write this channel; a structural check is enough on the hot path.
    if (env.v !== 1 || !env.frame || typeof env.frame.op !== "string") return;
    if (typeof env.sentAt === "number") this.d.metrics.fanoutLatency(Date.now() - env.sentAt);
    const frame = env.frame;
    if (frame.op === "message" && !frame.held)
      this.d.rooms.remember(channelId, frame.message.id, frame.message.user.username, frame.message.body);
    this.d.rooms.deliver(channelId, JSON.stringify(frame), env.audience === "moderators" ? "moderators" : "all");
  }

  onControl(channelId: string, raw: string): void {
    const msg = parseJson(ChatControlMessage, raw);
    if (!msg) {
      this.d.logger.warn("malformed chat control message", { channelId });
      return;
    }
    if (msg.op === "invalidate") {
      if (msg.scope === "channel") this.d.directory.invalidateChannel(channelId);
      else {
        this.d.directory.invalidateStanding(channelId, msg.userId);
        void this.refreshModerators(channelId, msg.userId);
      }
      return;
    }
    if (msg.op === "ban") this.d.directory.invalidateStanding(channelId, msg.userId);
    if (msg.op === "settings") this.d.directory.invalidateChannel(channelId);
    this.d.rooms.deliver(channelId, JSON.stringify(msg));
  }

  /** Recompute held-message visibility after a role change. */
  private async refreshModerators(channelId: string, userId: string | undefined): Promise<void> {
    const room = this.d.rooms.get(channelId);
    if (!room) return;
    try {
      const loaded = await this.d.directory.channel(room.slug);
      if (!loaded) return;
      const users = userId ? [userId] : [...this.d.rooms.usersIn(channelId)];
      for (const id of users) {
        const standing = await this.d.directory.standing(loaded.state, id);
        this.d.rooms.setModeratorRole(channelId, id, canModerate(rankOf(standing)));
      }
    } catch (err) {
      this.d.logger.warn("moderator refresh failed", { err, channelId });
    }
  }

  onEvent(raw: string): void {
    let loose: { type?: unknown; channelId?: unknown };
    try {
      loose = JSON.parse(raw) as typeof loose;
    } catch {
      return;
    }
    // Cheap filters first: most bus traffic is chat messages and rooms this instance does not host.
    if (typeof loose.type !== "string" || !isInlineEvent(loose.type) || typeof loose.channelId !== "string") return;
    const room = this.d.rooms.get(loose.channelId);
    if (!room) return;
    const evt = BusEvent.safeParse(loose);
    if (!evt.success || !evt.data.channelId) return;
    this.d.rooms.deliver(
      evt.data.channelId,
      JSON.stringify({
        op: "event",
        channel: room.slug,
        type: evt.data.type,
        data: evt.data.payload,
      } satisfies ServerFrame),
    );
  }

  onLive(raw: string): void {
    try {
      const evt = JSON.parse(raw) as { channelId?: unknown };
      // liveBroadcastId changed: reload so new messages carry the right broadcast.
      if (typeof evt.channelId === "string") this.d.directory.invalidateChannel(evt.channelId);
    } catch {
      // ignore malformed live events
    }
  }
}
