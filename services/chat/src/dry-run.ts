// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat dry run (`INTERNAL_ROUTES.chatDryRun`, batch 6 decision (f)): rehearsal's simulated chat
 * runs the real send pipeline (channel settings, rate limit, duplicates, links, word filters,
 * middlewares) for a synthetic sender and learns accepted, held or rejected. Nothing is persisted,
 * fanned out, published on the event bus or replayed: the message never reaches the channel's
 * public chat or its replay, and no plugin `onMessage` hook runs.
 *
 * The synthetic sender is an established viewer (verified email, a year-old account, a follower
 * for 30 days), so the channel's entry gates do not hide the filters a rehearsal exercises. The
 * verified-watch gate keys on the live broadcast, which a rehearsal never is, so it is not
 * applied. The sender's id is derived from the channel and `senderKey`, so rate, slow-mode and
 * duplicate rules apply per sender as for a person; its username contains a character real
 * usernames never do, so a middleware acting on it (a bot timeout) cannot reach a real account.
 */
import { eq } from "drizzle-orm";
import { ChatDryRunBody, INTERNAL_SECRET_HEADER, type ChatDryRunResult } from "@commonair/contracts/internal";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { sha256Hex, timingSafeEqual } from "@commonair/tokens";
import type { FilterRunner } from "@commonair/chat-filter";
import type { Directory } from "./directory.ts";
import { errorFields } from "./errors.ts";
import type { Limiter } from "./limiter.ts";
import { runSendPipeline, type MessageMiddleware } from "./pipeline.ts";
import { NO_STANDING, type Standing, type UserProfile } from "./types.ts";

const DAY_MS = 86_400_000;

export interface DryRunDeps {
  db: Database;
  directory: Directory;
  limiter: Limiter;
  middlewares: readonly MessageMiddleware[];
  filterRunner?: FilterRunner;
  logger: Logger;
  now?: () => Date;
}

/** A stable UUID-shaped id for one synthetic sender of one channel (never a real account's). */
export async function syntheticSenderId(channelId: string, senderKey: string): Promise<string> {
  const h = await sha256Hex(`chat-dry-run:${channelId}:${senderKey}`);
  // Version nibble 8 (custom) keeps it valid as a uuid column value and distinct from uuidv7 ids.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function syntheticSender(id: string, senderKey: string, now: Date): UserProfile {
  return {
    id,
    // `~` never appears in a real username (`[a-z0-9_]`).
    username: `~sim_${senderKey}`.slice(0, 64),
    displayName: `sim ${senderKey}`.slice(0, 64),
    accountType: "human",
    botVerified: false,
    platformRole: "user",
    emailVerified: true,
    createdAt: new Date(now.getTime() - 365 * DAY_MS),
    banned: false,
    banExpires: null,
    deleted: false,
    isMember: false,
  };
}

/** Run one simulated message through the send pipeline. Null when the channel does not exist. */
export async function dryRun(deps: DryRunDeps, input: ChatDryRunBody): Promise<ChatDryRunResult | null> {
  const [row] = await deps.db
    .select({ slug: schema.channels.slug })
    .from(schema.channels)
    .where(eq(schema.channels.id, input.channelId))
    .limit(1);
  if (!row) return null;
  const loaded = await deps.directory.channel(row.slug);
  if (!loaded) return null;
  const now = deps.now?.() ?? new Date();
  const id = await syntheticSenderId(input.channelId, input.senderKey);
  const standing: Standing = { ...NO_STANDING, followedAt: new Date(now.getTime() - 30 * DAY_MS) };
  const result = await runSendPipeline(
    { limiter: deps.limiter, middlewares: deps.middlewares, filterRunner: deps.filterRunner },
    {
      messageId: crypto.randomUUID(),
      receivedAt: now,
      user: syntheticSender(id, input.senderKey, now),
      scopes: ["chat:read", "chat:edit"],
      viaAppId: null,
      channel: loaded.state,
      filters: loaded.filters,
      standing,
      body: input.body,
      isAction: false,
      replyToId: null,
      dryRun: true,
      logger: deps.logger,
    },
  );
  if (!result.ok) return { outcome: "rejected", code: result.rejection.code };
  return { outcome: result.held ? "held" : "accepted", code: null };
}

/** The HTTP route: `POST INTERNAL_ROUTES.chatDryRun` with the internal secret header. */
export function createDryRunRoute(deps: DryRunDeps & { internalSecret: string }) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (!timingSafeEqual(req.headers.get(INTERNAL_SECRET_HEADER) ?? "", deps.internalSecret))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const parsed = ChatDryRunBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
    try {
      const result = await dryRun(deps, parsed.data);
      if (!result) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(result);
    } catch (err) {
      deps.logger.error("chat dry run failed", errorFields(err));
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}
