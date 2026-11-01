// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Key rotation (ADR 0030 decision 4). The `rotate` job runs two ways:
 *
 * - With a `channelId`: an admin rotated that actor's key through the API (which stored the new
 *   key, appended the old one to `federation_actor_keys` and wrote the audit row). The job sends
 *   `Update{Service}` with the current key to every follower inbox.
 * - Scheduled (no `channelId`): every enabled actor whose key is older than
 *   `FEDERATION_RULES.keyRotateDays` gets a new RSA-2048 key here, in one transaction with the
 *   history row and an `audit_log` row, then the same `Update`.
 */
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { schema as s, uuidv7 } from "@commonair/db";
import { generateActorKey, updateServiceActivity } from "@commonair/federation";
import { encryptSecret } from "@commonair/tokens";
import { and, eq, lte } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { FEDERATION_KEY_PURPOSE, type FederationConfig } from "./config.ts";
import { enqueueDeliveries } from "./deliver.ts";
import { followerInboxes, type LocalChannel, loadChannel, serviceActorInput } from "./local.ts";

const DAY = 86_400_000;

type Ctx = Pick<WorkerContext, "db" | "logger" | "enqueueBulk" | "now">;

export interface RotateResult {
  rotated: number;
  updates: number;
  deliveries: number;
}

/** Send `Update{Service}` with the channel's current key to its followers. */
export async function sendKeyUpdate(ctx: Ctx, cfg: FederationConfig, ch: LocalChannel): Promise<number> {
  if (!ch.actor) return 0;
  const activity = updateServiceActivity(serviceActorInput(cfg, ch, ch.actor.publicKeyPem), ch.actor.keyCreatedAt);
  return enqueueDeliveries(ctx, ch.id, null, activity, await followerInboxes(ctx.db, ch.id));
}

/** Rotate one actor's key now: history row, new key, audit row, in one transaction. */
export async function rotateActorKey(
  ctx: Ctx,
  cfg: FederationConfig,
  channelId: string,
  reason: string,
): Promise<boolean> {
  const pair = await generateActorKey();
  const privateKeyEnc = await encryptSecret(cfg.authSecret, FEDERATION_KEY_PURPOSE, pair.privateKeyPem);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(s.federationActors)
      .where(eq(s.federationActors.channelId, channelId))
      .for("update");
    if (!old) return false;
    await tx.insert(s.federationActorKeys).values({
      id: uuidv7(),
      channelId,
      keyId: old.keyId,
      publicKeyPem: old.publicKeyPem,
      keyCreatedAt: old.keyCreatedAt,
      retiredAt: now,
    });
    await tx
      .update(s.federationActors)
      .set({ publicKeyPem: pair.publicKeyPem, privateKeyEnc, keyCreatedAt: now, updatedAt: now })
      .where(eq(s.federationActors.channelId, channelId));
    await tx.insert(s.auditLog).values({
      id: uuidv7(),
      actorType: "system",
      action: "federation.key.rotate",
      subjectType: "channel",
      subjectId: channelId,
      channelId,
      details: { reason },
    });
    return true;
  });
}

export async function runRotate(
  data: { channelId?: string | undefined },
  ctx: Ctx,
  cfg: FederationConfig,
): Promise<RotateResult> {
  if (!cfg.enabled) return { rotated: 0, updates: 0, deliveries: 0 };
  if (data.channelId) {
    const ch = await loadChannel(ctx.db, cfg, data.channelId);
    if (!ch?.actor) return { rotated: 0, updates: 0, deliveries: 0 };
    const n = await sendKeyUpdate(ctx, cfg, ch);
    return { rotated: 0, updates: 1, deliveries: n };
  }
  const cutoff = new Date(ctx.now().getTime() - FEDERATION_RULES.keyRotateDays * DAY);
  const due = await ctx.db
    .select({ channelId: s.federationActors.channelId })
    .from(s.federationActors)
    .where(and(eq(s.federationActors.enabled, true), lte(s.federationActors.keyCreatedAt, cutoff)));
  let rotated = 0;
  let updates = 0;
  let deliveries = 0;
  for (const { channelId } of due) {
    if (!(await rotateActorKey(ctx, cfg, channelId, "scheduled"))) continue;
    rotated++;
    const ch = await loadChannel(ctx.db, cfg, channelId);
    if (!ch) continue;
    updates++;
    deliveries += await sendKeyUpdate(ctx, cfg, ch);
  }
  if (rotated > 0) ctx.logger.info("federation keys rotated", { rotated });
  return { rotated, updates, deliveries };
}
