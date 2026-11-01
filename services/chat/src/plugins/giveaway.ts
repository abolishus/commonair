// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The giveaway chat plugin (decision (t), ADR 0039 §2): while a giveaway with a keyword is open, an
 * accepted chat message that is the keyword (case-insensitive) enters the sender through the shared
 * `enterGiveaway` in `@commonair/interact` (the same rules as the API's button). It runs after the
 * send (`onMessage`), so a message the chat rules refused or held never enters anyone, and the
 * keyword message itself stays in chat.
 *
 * The channel bot (when the channel has one) confirms an entry at most once per
 * `replyIntervalMs` per channel and instance, naming only the sender; it never lists entrants and
 * never explains a refusal in chat (the card does). A no-op while `GIVEAWAYS_ENABLED` is false
 * (decision (a)).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { schema } from "@commonair/db";
import { enterGiveaway } from "@commonair/interact";
import { errorFields } from "../errors.ts";
import type { MessageContext, MessageMiddleware, PluginHost } from "../pipeline.ts";

export interface GiveawayPluginOptions {
  /** `GIVEAWAYS_ENABLED`. */
  enabled: boolean;
  /** Minimum gap between bot confirmations in one channel (default 30 s). */
  replyIntervalMs?: number;
  /** How long a channel's open keyword giveaway is cached (default 5 s). */
  cacheMs?: number;
}

/** The contract's keyword shape (`interact.giveaways.open`): a quick filter before any lookup. */
const KEYWORD_SHAPE = /^!?[A-Za-z0-9]{2,20}$/;
const DEFAULT_REPLY_INTERVAL_MS = 30_000;
const DEFAULT_CACHE_MS = 5_000;
const MAX_TRACKED_CHANNELS = 10_000;

interface Open {
  id: string;
  keyword: string;
}

export interface GiveawayMiddleware extends MessageMiddleware {
  /** Entries this instance made (tests). */
  entered(): number;
}

export function createGiveawayMiddleware(opts: GiveawayPluginOptions): GiveawayMiddleware {
  const replyIntervalMs = opts.replyIntervalMs ?? DEFAULT_REPLY_INTERVAL_MS;
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  let host: PluginHost | null = null;
  let entries = 0;
  const openCache = new Map<string, { at: number; open: Open | null }>();
  const lastReply = new Map<string, number>();

  const remember = <V>(m: Map<string, V>, key: string, value: V) => {
    if (m.size >= MAX_TRACKED_CHANNELS) m.clear();
    m.set(key, value);
  };

  async function openKeywordGiveaway(h: PluginHost, channelId: string): Promise<Open | null> {
    const now = Date.now();
    const hit = openCache.get(channelId);
    if (hit && now - hit.at < cacheMs) return hit.open;
    const g = schema.giveaways;
    const [row] = await h.db
      .select({ id: g.id, keyword: g.keyword })
      .from(g)
      .where(and(eq(g.channelId, channelId), eq(g.status, "open"), isNotNull(g.keyword)));
    const open = row?.keyword ? { id: row.id, keyword: row.keyword } : null;
    remember(openCache, channelId, { at: now, open });
    return open;
  }

  async function confirm(h: PluginHost, ctx: MessageContext): Promise<void> {
    const now = Date.now();
    const last = lastReply.get(ctx.channel.id);
    if (last !== undefined && now - last < replyIntervalMs) return;
    const b = schema.botConfigs;
    const [bot] = await h.db
      .select({ userId: b.botUserId })
      .from(b)
      .where(and(eq(b.channelId, ctx.channel.id), eq(b.enabled, true), isNotNull(b.botUserId)));
    if (!bot?.userId) return;
    remember(lastReply, ctx.channel.id, now);
    // Bot replies are channel content in the instance language, as the channel bot's own replies.
    await h.say({
      channel: ctx.channel.slug,
      userId: bot.userId,
      body: `@${ctx.user.displayName}, you're in the giveaway. Good luck!`,
    });
  }

  return {
    name: "giveaway",
    entered: () => entries,
    init(h) {
      host = h;
    },
    async process() {
      return "continue";
    },
    async onMessage(ctx) {
      const h = host;
      if (!opts.enabled || !h || ctx.dryRun || ctx.held) return;
      const body = ctx.body.trim();
      if (!KEYWORD_SHAPE.test(body)) return;
      try {
        const open = await openKeywordGiveaway(h, ctx.channel.id);
        if (!open || open.keyword.toLowerCase() !== body.toLowerCase()) return;
        const r = await enterGiveaway(h.db, h.valkey, { giveawayId: open.id, userId: ctx.user.id, now: new Date() });
        if (!r.ok) {
          // Closed since it was cached: look again next time.
          if (r.code === "closed" || r.code === "not_found") openCache.delete(ctx.channel.id);
          return;
        }
        entries++;
        await confirm(h, ctx);
      } catch (err) {
        h.logger.warn("giveaway keyword entry failed", { ...errorFields(err), channelId: ctx.channel.id });
      }
    },
  };
}
