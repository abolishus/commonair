// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The send pipeline. Rules run in a fixed order and the first failure wins:
 *
 *   auth + chat:edit → platform ban → channel suspended → channel ban/timeout →
 *   verified email → account age → followers-only → verified watch → subscribers-only → emote-only →
 *   slow mode → rate limit → duplicate → links → word filters → middleware chain
 *
 * Middlewares (`MessageMiddleware`) are the extension point for the built-in channel bot,
 * the stream-key-leak scanner and similar plugins: they are listed in `plugins/index.ts`
 * and can drop or rewrite a message, and observe accepted messages via `onMessage`.
 */
import { CHAT_LIMITS, type dto, type EmoteRange, type NoticeCode } from "@commonair/contracts";
import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { type CompiledFilter, containsLink } from "./content.ts";
import { type FilterRunner, inlineFilterRunner } from "./filter-runner.ts";
import { emoteTierFor, parseEmotes } from "./emotes.ts";
import type { Limiter, Reservation } from "./limiter.ts";
import { errorFields } from "./errors.ts";
import { ALL_CHANNELS, checkGates, globalRateLimitFor, isPrivileged, rateLimitFor, slowModeApplies } from "./rules.ts";
import type { ChannelState, Rejection, Standing, UserProfile } from "./types.ts";

export interface MessageContext {
  readonly messageId: string;
  readonly receivedAt: Date;
  readonly channel: Readonly<ChannelState>;
  readonly user: Readonly<UserProfile>;
  readonly standing: Readonly<Standing>;
  /** OAuth app that sent the message, if any. */
  readonly viaAppId: string | null;
  /** Current body: after word-filter replacements and earlier middleware transforms. */
  readonly body: string;
  readonly isAction: boolean;
  readonly replyToId: string | null;
  /** Held messages are visible to moderators only and never reach `onMessage`. */
  readonly held: boolean;
  readonly logger: Logger;
}

export type MiddlewareResult = "continue" | { drop: NoticeCode; text?: string } | { transform: string };

export interface MessageMiddleware {
  readonly name: string;
  /** Called once at startup with host services (send as a bot, run commands). */
  init?(host: PluginHost): void | Promise<void>;
  process(ctx: MessageContext): Promise<MiddlewareResult>;
  /** Post-send hook for accepted, non-held messages. Errors are logged and ignored. */
  onMessage?(ctx: MessageContext, message: dto.ChatMessage): Promise<void>;
  /** Called on shutdown. */
  close?(): Promise<void>;
}

/** What plugins may do back into chat. Both run the same authorization as a client would. */
export interface PluginHost {
  logger: Logger;
  /** Send a message as `userId` (e.g. the channel bot account). Middlewares are skipped to avoid loops. */
  say(input: {
    channel: string;
    userId: string;
    body: string;
    isAction?: boolean;
  }): Promise<{ id: string | null; notice: NoticeCode | null }>;
  /** Run a chat command (e.g. `timeout`) as `userId`. Returns the resulting notice codes. */
  command(input: { channel: string; userId: string; command: string; args: string[] }): Promise<NoticeCode[]>;
  /** The chat service's database (app role) and Valkey (key prefix applied), for plugins with state. */
  db: Database;
  valkey: ValkeyClient;
  /** Subscribe to a pub/sub channel (a `BUS` name; the service's bus prefix is applied). */
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  /** Rooms with at least one member on this instance: timers only fire where someone listens. */
  hostedChannels(): Array<{ id: string; slug: string }>;
}

export interface PipelineInput {
  messageId: string;
  receivedAt: Date;
  user: UserProfile | null;
  scopes: readonly string[];
  viaAppId: string | null;
  channel: ChannelState;
  filters: readonly CompiledFilter[];
  standing: Standing;
  body: string;
  isAction: boolean;
  replyToId: string | null;
  logger: Logger;
}

export type PipelineResult =
  | { ok: false; rejection: Rejection }
  | { ok: true; held: boolean; body: string; emotes: EmoteRange[]; ctx: MessageContext };

export interface PipelineDeps {
  limiter: Limiter;
  middlewares: readonly MessageMiddleware[];
  /** Where word filters run (default: inline, bounded only between filters). */
  filterRunner?: FilterRunner;
}

const reject = (code: NoticeCode, text: string): PipelineResult => ({ ok: false, rejection: { code, text } });

export async function runSendPipeline(deps: PipelineDeps, input: PipelineInput): Promise<PipelineResult> {
  const { channel, standing, user, receivedAt } = input;
  const tier = emoteTierFor(standing);
  const parsed = parseEmotes(input.body, channel.emotes, tier);
  const gate = checkGates({
    user,
    scopes: input.scopes,
    channel,
    standing,
    emoteOnly: parsed.onlyEmotes,
    now: receivedAt,
  });
  if (gate) return { ok: false, rejection: gate };
  // checkGates guarantees a user from here on; keep the narrowing explicit for the compiler.
  if (!user) return reject("msg_requires_login", "You must be logged in to chat.");

  // Slow-mode and duplicate slots are claimed atomically now and released if a later rule rejects.
  const reservations: Reservation[] = [];
  const fail = async (code: NoticeCode, text: string): Promise<PipelineResult> => {
    await Promise.all(reservations.map((r) => r.release()));
    return reject(code, text);
  };

  if (slowModeApplies(channel, standing)) {
    const slow = await deps.limiter.reserveSlow(channel.id, user.id, channel.settings.slowModeSeconds);
    if (!slow.ok)
      return reject(
        "msg_slowmode",
        `This room is in slow mode. You may send another message in ${Math.ceil(slow.waitMs / 1000)} seconds.`,
      );
    reservations.push(slow.reservation);
  }
  const now = receivedAt.getTime();
  const rate = rateLimitFor(user, standing, channel.id);
  if (!(await deps.limiter.hit(rate.bucket, user.id, rate.limit, CHAT_LIMITS.windowMs, now)))
    return fail("msg_ratelimit", "You are sending messages too quickly.");
  const global = globalRateLimitFor(user, standing);
  if (global !== null && !(await deps.limiter.hit(ALL_CHANNELS, user.id, global, CHAT_LIMITS.windowMs, now)))
    return fail("msg_ratelimit", "You are sending messages too quickly across channels.");
  const dup = await deps.limiter.reserveDuplicate(channel.id, user.id, input.body, CHAT_LIMITS.duplicateWindowMs);
  if (!dup) return fail("msg_duplicate", "Your message was not sent because it is identical to a recent message.");
  reservations.push(dup);

  const privileged = isPrivileged(standing);
  if (!channel.settings.linksAllowed && !privileged && containsLink(input.body))
    return fail("msg_links_blocked", "Links are not allowed in this channel.");

  let body = input.body;
  let held = false;
  if (!privileged) {
    const outcome = await (deps.filterRunner ?? inlineFilterRunner).run(body, input.filters);
    if (outcome.action === "block")
      return fail("msg_rejected", "Your message was not sent because it matched a channel filter.");
    if (outcome.timedOut)
      input.logger.warn("word filters exceeded their time budget; message held", { channelId: channel.id });
    body = outcome.body;
    held = outcome.action === "hold";
  }

  const ctx = (): MessageContext => ({
    messageId: input.messageId,
    receivedAt,
    channel,
    user,
    standing,
    viaAppId: input.viaAppId,
    body,
    isAction: input.isAction,
    replyToId: input.replyToId,
    held,
    logger: input.logger,
  });
  for (const mw of deps.middlewares) {
    let result: MiddlewareResult;
    try {
      result = await mw.process(ctx());
    } catch (err) {
      // A broken plugin must not take chat down; it is skipped, not trusted.
      input.logger.error("chat middleware failed", { ...errorFields(err), middleware: mw.name });
      continue;
    }
    if (result === "continue") continue;
    if ("drop" in result) return fail(result.drop, result.text ?? "Your message was not sent.");
    const next = result.transform.trim();
    if (next.length === 0) return fail("msg_rejected", "Your message was not sent.");
    body = next.slice(0, CHAT_LIMITS.maxBodyLength);
  }

  const emotes = body === input.body ? parsed.ranges : parseEmotes(body, channel.emotes, tier).ranges;
  return { ok: true, held, body, emotes, ctx: ctx() };
}
