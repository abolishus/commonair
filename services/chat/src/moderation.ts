// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Moderation command execution. Each command writes its domain rows, a `mod_actions` row, an
 * `audit_log` row and an outbox event in one transaction, then publishes a control message on
 * BUS.chatControl so every chat instance (and through them the IRC gateway) updates.
 * Free-text reasons go to `mod_actions` only: `audit_log` is append-only and must not hold
 * user-written text (ADR 0004).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { ChannelChatSettings, type EventPayload, type EventType, type NoticeCode } from "@commonair/contracts";
import type { MOD_ACTIONS } from "@commonair/contracts/enums";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { Command } from "./commands.ts";
import { errorFields } from "./errors.ts";
import type { ChatControlMessage } from "./control.ts";
import type { Directory } from "./directory.ts";
import { canActOn, canManageRoles, canModerate, rankOf, requiredRank } from "./permissions.ts";
import { channelBanState, platformBanActive } from "./rules.ts";
import type { ChannelState, Rejection, Standing, UserProfile } from "./types.ts";

const { chatBans, chatMessages, channelRoles, channels, modActions, auditLog, events, users } = schema;

export const MODERATE_SCOPE = "moderator:manage:chat";

export interface Actor {
  user: UserProfile;
  standing: Standing;
  scopes: readonly string[];
}

export type ModCommand = Exclude<Command, { kind: "me" }>;

export interface ModerationDeps {
  db: Database;
  directory: Directory;
  publishControl(channelId: string, message: ChatControlMessage): Promise<void>;
  /** Flush locally buffered chat messages so a just-sent message can be deleted. */
  flushMessages(): Promise<void>;
  logger: Logger;
  /** How long to keep looking for a message buffered on another instance before giving up on a delete. */
  deleteRetryMs?: number;
}

type ModAction = (typeof MOD_ACTIONS)[number];
type Target = { id: string; username: string; displayName: string };

const notice = (code: NoticeCode, text: string): Rejection => ({ code, text });
const denied = (text = "You don't have permission to perform that action."): Rejection => notice("no_permission", text);

export class Moderation {
  constructor(private readonly deps: ModerationDeps) {}

  /** Authorize and run one command. Always resolves to the notice for the actor. */
  async execute(actor: Actor, channel: ChannelState, cmd: ModCommand): Promise<Rejection> {
    const rank = rankOf(actor.standing);
    const need = requiredRank(cmd.kind);
    if (platformBanActive(actor.user, new Date()) || !actor.scopes.includes(MODERATE_SCOPE)) return denied();
    // A moderator who is banned or timed out in this channel has no moderation rights in it.
    if (channelBanState(actor.standing, new Date()) !== null)
      return denied("You are banned or timed out in this channel.");
    if (need === "moderator" && !canModerate(rank)) return denied();
    if (need === "broadcaster" && !canManageRoles(rank)) return denied("Only the broadcaster can do that.");

    switch (cmd.kind) {
      case "ban":
      case "timeout":
        return this.ban(actor, channel, cmd.target, cmd.reason, cmd.kind === "timeout" ? cmd.seconds : null);
      case "unban":
      case "untimeout":
        return this.unban(actor, channel, cmd.target, cmd.kind);
      case "delete":
        return this.deleteMessage(actor, channel, cmd.messageId);
      case "clear":
        return this.clear(actor, channel);
      case "slow":
        return this.settings(actor, channel, { slowModeSeconds: cmd.seconds }, "slow_mode", cmd.seconds);
      case "slowoff":
        return this.settings(actor, channel, { slowModeSeconds: 0 }, "slow_mode", 0);
      case "followers":
        return this.settings(actor, channel, { followersOnlyMinutes: cmd.minutes }, "followers_only", cmd.minutes * 60);
      case "followersoff":
        return this.settings(actor, channel, { followersOnlyMinutes: null }, "followers_only", null);
      case "subscribers":
      case "subscribersoff":
        return this.settings(actor, channel, { subscribersOnly: cmd.kind === "subscribers" }, "subscribers_only", null);
      case "emoteonly":
      case "emoteonlyoff":
        return this.settings(actor, channel, { emoteOnly: cmd.kind === "emoteonly" }, "emote_only", null);
      case "mod":
      case "unmod":
      case "vip":
      case "unvip":
        return this.role(actor, channel, cmd.target, cmd.kind);
    }
  }

  /** Resolve a target user and check the actor may act on them. */
  private async target(actor: Actor, channel: ChannelState, username: string): Promise<Target | Rejection> {
    const target = await this.deps.directory.userByUsername(username);
    if (!target) return notice("invalid_user", `No user named ${username}.`);
    if (target.id === actor.user.id) return denied("You cannot do that to yourself.");
    const standing = await this.deps.directory.standing(channel, target.id);
    if (!canActOn(rankOf(actor.standing), rankOf(standing))) return denied(`You cannot moderate ${target.username}.`);
    return target;
  }

  private async ban(
    actor: Actor,
    channel: ChannelState,
    username: string,
    reason: string,
    seconds: number | null,
  ): Promise<Rejection> {
    const target = await this.target(actor, channel, username);
    if ("code" in target) return target;
    const now = new Date();
    const expiresAt = seconds === null ? null : new Date(now.getTime() + seconds * 1000);
    const demoted = await this.deps.db.transaction(async (tx) => {
      // The partial unique index allows one unlifted row per user; replace it (it may be an expired timeout).
      await tx
        .update(chatBans)
        .set({ liftedAt: now, liftedBy: actor.user.id })
        .where(and(eq(chatBans.channelId, channel.id), eq(chatBans.userId, target.id), isNull(chatBans.liftedAt)));
      await tx.insert(chatBans).values({
        id: uuidv7(),
        channelId: channel.id,
        userId: target.id,
        moderatorId: actor.user.id,
        reason,
        expiresAt,
      });
      await this.record(tx, actor, channel, {
        action: seconds === null ? "ban" : "timeout",
        audit: seconds === null ? "chat.ban" : "chat.timeout",
        target: target.id,
        reason,
        durationSeconds: seconds,
      });
      await this.outbox(tx, channel, "channel.ban", {
        ...this.broadcaster(channel),
        ...userFields(target),
        ...moderatorFields(actor.user),
        reason,
        banned_at: now.toISOString(),
        ends_at: expiresAt?.toISOString() ?? null,
        is_permanent: expiresAt === null,
      });
      // A permanent ban also strips the target's channel roles (only the broadcaster can ban a moderator).
      if (seconds !== null) return false;
      const removed = await tx
        .delete(channelRoles)
        .where(and(eq(channelRoles.channelId, channel.id), eq(channelRoles.userId, target.id)))
        .returning({ role: channelRoles.role });
      for (const { role } of removed) {
        if (role !== "moderator" && role !== "vip") continue;
        await this.record(tx, actor, channel, {
          action: role === "moderator" ? "remove_moderator" : "remove_vip",
          audit: role === "moderator" ? "chat.remove_moderator" : "chat.remove_vip",
          target: target.id,
        });
        if (role === "moderator")
          await this.outbox(tx, channel, "channel.moderator.remove", {
            ...this.broadcaster(channel),
            ...userFields(target),
          });
      }
      return removed.length > 0;
    });
    this.deps.directory.invalidateStanding(channel.id, target.id);
    if (demoted) await this.publish(channel.id, { op: "invalidate", scope: "user", userId: target.id });
    await this.publish(channel.id, {
      op: "ban",
      channel: channel.slug,
      userId: target.id,
      username: target.username,
      expiresAt: expiresAt?.toISOString() ?? null,
      reason,
    });
    return notice(
      "cmd_success",
      seconds === null
        ? `${target.username} is now banned.`
        : `${target.username} has been timed out for ${seconds} seconds.`,
    );
  }

  private async unban(
    actor: Actor,
    channel: ChannelState,
    username: string,
    kind: "unban" | "untimeout",
  ): Promise<Rejection> {
    const target = await this.target(actor, channel, username);
    if ("code" in target) return target;
    const now = new Date();
    const lifted = await this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(chatBans)
        .set({ liftedAt: now, liftedBy: actor.user.id })
        .where(
          and(
            eq(chatBans.channelId, channel.id),
            eq(chatBans.userId, target.id),
            isNull(chatBans.liftedAt),
            // An unban lifts bans and timeouts; an untimeout lifts only an unexpired timeout.
            kind === "untimeout"
              ? sql`${chatBans.expiresAt} > now()`
              : sql`(${chatBans.expiresAt} is null or ${chatBans.expiresAt} > now())`,
          ),
        )
        .returning({ id: chatBans.id });
      if (rows.length === 0) return false;
      await this.record(tx, actor, channel, { action: kind, audit: `chat.${kind}`, target: target.id });
      await this.outbox(tx, channel, "channel.unban", {
        ...this.broadcaster(channel),
        ...userFields(target),
        ...moderatorFields(actor.user),
      });
      return true;
    });
    if (!lifted)
      return notice(
        "msg_rejected",
        kind === "untimeout" ? `${target.username} is not timed out.` : `${target.username} is not banned.`,
      );
    this.deps.directory.invalidateStanding(channel.id, target.id);
    await this.publish(channel.id, { op: "invalidate", scope: "user", userId: target.id });
    return notice(
      "cmd_success",
      kind === "untimeout" ? `${target.username} is no longer timed out.` : `${target.username} is no longer banned.`,
    );
  }

  private async findMessage(channel: ChannelState, messageId: string) {
    const [row] = await this.deps.db
      .select({
        id: chatMessages.id,
        userId: chatMessages.userId,
        deletedAt: chatMessages.deletedAt,
        username: users.username,
        name: users.name,
        displayUsername: users.displayUsername,
      })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.userId))
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.channelId, channel.id)))
      .limit(1);
    return row;
  }

  private async deleteMessage(actor: Actor, channel: ChannelState, messageId: string): Promise<Rejection> {
    await this.deps.flushMessages();
    let msg = await this.findMessage(channel, messageId);
    // The message may still sit in another instance's write buffer (flushed every 250 ms).
    const deadline = Date.now() + (this.deps.deleteRetryMs ?? 750);
    while (!msg && Date.now() < deadline) {
      await Bun.sleep(100);
      msg = await this.findMessage(channel, messageId);
    }
    if (!msg || msg.deletedAt) return notice("msg_rejected", "That message does not exist or was already deleted.");
    const author = { id: msg.userId, username: msg.username, displayName: msg.displayUsername ?? msg.name };
    if (author.id !== actor.user.id) {
      const standing = await this.deps.directory.standing(channel, author.id);
      if (!canActOn(rankOf(actor.standing), rankOf(standing)))
        return denied(`You cannot delete messages from ${author.username}.`);
    }
    const now = new Date();
    const deleted = await this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(chatMessages)
        .set({ deletedAt: now, deletedBy: actor.user.id })
        .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
        .returning({ id: chatMessages.id });
      if (rows.length === 0) return false;
      await this.record(tx, actor, channel, {
        action: "delete_message",
        audit: "chat.delete_message",
        target: author.id,
        subject: { type: "chat_message", id: messageId },
      });
      await this.outbox(tx, channel, "channel.chat.message_delete", {
        ...this.broadcaster(channel),
        target_user_id: author.id,
        target_user_login: author.username,
        target_user_name: author.displayName,
        message_id: messageId,
      });
      return true;
    });
    if (!deleted) return notice("msg_rejected", "That message was already deleted.");
    await this.publish(channel.id, { op: "delete", channel: channel.slug, messageId, username: author.username });
    return notice("cmd_success", "The message was deleted.");
  }

  private async clear(actor: Actor, channel: ChannelState): Promise<Rejection> {
    await this.deps.db.transaction(async (tx) => {
      await this.record(tx, actor, channel, { action: "clear_chat", audit: "chat.clear", target: null });
      await this.outbox(tx, channel, "channel.chat.clear", { ...this.broadcaster(channel) });
    });
    await this.publish(channel.id, { op: "clear", channel: channel.slug });
    return notice("cmd_success", "Chat was cleared by a moderator.");
  }

  private async settings(
    actor: Actor,
    channel: ChannelState,
    patch: Partial<ChannelChatSettings>,
    action: ModAction,
    durationSeconds: number | null,
  ): Promise<Rejection> {
    const settings = await this.deps.db.transaction(async (tx) => {
      // jsonb merge in SQL so concurrent mode changes from other moderators are not lost.
      const [row] = await tx
        .update(channels)
        .set({ chatSettings: sql`${channels.chatSettings} || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(channels.id, channel.id))
        .returning({ chatSettings: channels.chatSettings });
      const next = ChannelChatSettings.parse(row?.chatSettings ?? {});
      await this.record(tx, actor, channel, {
        action,
        audit: `chat.settings.${action}`,
        target: null,
        durationSeconds,
        details: { patch },
      });
      await this.outbox(tx, channel, "channel.chat_settings.update", {
        ...this.broadcaster(channel),
        emote_mode: next.emoteOnly,
        follower_mode: next.followersOnlyMinutes !== null,
        follower_mode_duration_minutes: next.followersOnlyMinutes,
        slow_mode: next.slowModeSeconds > 0,
        slow_mode_wait_time_seconds: next.slowModeSeconds > 0 ? next.slowModeSeconds : null,
        subscriber_mode: next.subscribersOnly,
      });
      return next;
    });
    this.deps.directory.invalidateChannel(channel.id);
    await this.publish(channel.id, { op: "settings", channel: channel.slug, settings });
    return settingsNotice(patch, settings);
  }

  private async role(
    actor: Actor,
    channel: ChannelState,
    username: string,
    kind: "mod" | "unmod" | "vip" | "unvip",
  ): Promise<Rejection> {
    const target = await this.deps.directory.userByUsername(username);
    if (!target) return notice("invalid_user", `No user named ${username}.`);
    if (target.id === channel.ownerId) return denied("The broadcaster's role cannot be changed.");
    const role = kind === "mod" || kind === "unmod" ? "moderator" : "vip";
    const adding = kind === "mod" || kind === "vip";
    const action: ModAction = `${adding ? "add" : "remove"}_${role === "moderator" ? "moderator" : "vip"}`;
    const changed = await this.deps.db.transaction(async (tx) => {
      const rows = adding
        ? await tx
            .insert(channelRoles)
            .values({ channelId: channel.id, userId: target.id, role, grantedBy: actor.user.id })
            .onConflictDoNothing()
            .returning({ userId: channelRoles.userId })
        : await tx
            .delete(channelRoles)
            .where(
              and(
                eq(channelRoles.channelId, channel.id),
                eq(channelRoles.userId, target.id),
                eq(channelRoles.role, role),
              ),
            )
            .returning({ userId: channelRoles.userId });
      if (rows.length === 0) return false;
      await this.record(tx, actor, channel, { action, audit: `chat.${action}`, target: target.id });
      if (role === "moderator")
        await this.outbox(tx, channel, adding ? "channel.moderator.add" : "channel.moderator.remove", {
          ...this.broadcaster(channel),
          ...userFields(target),
        });
      return true;
    });
    const label = role === "moderator" ? "a moderator" : "a VIP";
    if (!changed)
      return notice(
        "msg_rejected",
        adding ? `${target.username} is already ${label}.` : `${target.username} is not ${label}.`,
      );
    this.deps.directory.invalidateStanding(channel.id, target.id);
    await this.publish(channel.id, { op: "invalidate", scope: "user", userId: target.id });
    return notice(
      "cmd_success",
      adding ? `${target.username} is now ${label}.` : `${target.username} is no longer ${label}.`,
    );
  }

  private async record(
    tx: Executor,
    actor: Actor,
    channel: ChannelState,
    r: {
      action: ModAction;
      audit: string;
      target: string | null;
      reason?: string;
      durationSeconds?: number | null;
      subject?: { type: string; id: string };
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    const modActionId = uuidv7();
    await tx.insert(modActions).values({
      id: modActionId,
      scope: "channel",
      channelId: channel.id,
      moderatorId: actor.user.id,
      targetUserId: r.target,
      action: r.action,
      reason: r.reason ?? "",
      durationSeconds: r.durationSeconds ?? null,
      subjectType: r.subject?.type ?? null,
      subjectId: r.subject?.id ?? null,
    });
    await tx.insert(auditLog).values({
      actorType: "moderator",
      actorId: actor.user.id,
      action: r.audit,
      subjectType: r.subject?.type ?? (r.target ? "user" : "channel"),
      subjectId: r.subject?.id ?? r.target ?? channel.id,
      channelId: channel.id,
      details: {
        modActionId,
        ...(typeof r.durationSeconds === "number" ? { durationSeconds: r.durationSeconds } : {}),
        ...r.details,
      },
    });
  }

  private async outbox<T extends EventType>(
    tx: Executor,
    channel: ChannelState,
    type: T,
    payload: EventPayload<T>,
  ): Promise<void> {
    await tx.insert(events).values({ type, version: "1", channelId: channel.id, payload });
  }

  private broadcaster(channel: ChannelState) {
    return {
      broadcaster_user_id: channel.ownerId,
      broadcaster_user_login: channel.slug,
      broadcaster_user_name: channel.displayName,
    };
  }

  private async publish(channelId: string, message: ChatControlMessage): Promise<void> {
    try {
      await this.deps.publishControl(channelId, message);
    } catch (err) {
      // The write is committed; caches converge through their TTLs even if this publish is lost.
      this.deps.logger.error("control publish failed", { ...errorFields(err), channelId, op: message.op });
    }
  }
}

const userFields = (u: Target) => ({ user_id: u.id, user_login: u.username, user_name: u.displayName });
const moderatorFields = (u: UserProfile) => ({
  moderator_user_id: u.id,
  moderator_user_login: u.username,
  moderator_user_name: u.displayName,
});

export function settingsNotice(patch: Partial<ChannelChatSettings>, s: ChannelChatSettings): Rejection {
  if ("slowModeSeconds" in patch)
    return s.slowModeSeconds > 0
      ? notice("slow_on", `This room is now in slow mode. You may send messages every ${s.slowModeSeconds} seconds.`)
      : notice("slow_off", "This room is no longer in slow mode.");
  if ("followersOnlyMinutes" in patch)
    return s.followersOnlyMinutes !== null
      ? notice(
          "followers_on",
          s.followersOnlyMinutes === 0
            ? "This room is now in followers-only mode."
            : `This room is now in ${s.followersOnlyMinutes}-minute followers-only mode.`,
        )
      : notice("followers_off", "This room is no longer in followers-only mode.");
  if ("subscribersOnly" in patch)
    return s.subscribersOnly
      ? notice("subs_on", "This room is now in subscribers-only mode.")
      : notice("subs_off", "This room is no longer in subscribers-only mode.");
  return s.emoteOnly
    ? notice("emote_only_on", "This room is now in emote-only mode.")
    : notice("emote_only_off", "This room is no longer in emote-only mode.");
}
