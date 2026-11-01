// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion's federation step (ADR 0030): the deleted streamer's channel stops federating
 * in the deletion transaction. Its actor goes (with the private key) and so do its followers'
 * actor ids and inboxes, which are remote people's data. Public key history
 * (`federation_actor_keys`, append-only) and object ids stay: they hold no personal data.
 * `completeDeletion` merges the returned counts into its own.
 *
 * Remote servers are told with `Delete` of the actor, in two halves so nothing leaves before the
 * deletion commits:
 *
 * 1. `captureRetiredActor(tx, …)`, inside the transaction and before `deleteFederationData`,
 *    reads what the `Delete` needs while the rows still exist: the follower inboxes and the
 *    still-encrypted key. It writes nothing.
 * 2. `sendRetiredActorDelete(ctx, …)`, after the commit, stashes the key in Valkey
 *    (`retiredKeyStashKey`, a day's TTL, longer than every retry) and queues the deliveries,
 *    which sign with the stash (the actor row is gone by then).
 *
 * A rollback therefore sends nothing. A crash between the commit and step 2 loses the `Delete`
 * (the rows are gone, so no later run can rebuild it); remote servers then keep a stale actor
 * whose key fetch 404s, which is how they learn of most deleted accounts anyway.
 */
import { schema as s, type Executor } from "@commonair/db";
import { actorUrls, deleteActorActivity } from "@commonair/federation";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { FederationConfig } from "../federation/config.ts";
import {
  enqueueDeliveries,
  RETIRED_KEY_TTL_SECONDS,
  type RetiredKey,
  retiredKeyStashKey,
} from "../federation/deliver.ts";
import { followerInboxes } from "../federation/local.ts";

/** What the after-commit `Delete` of a deleted channel's actor needs (no personal data). */
export interface RetiredActor {
  channelId: string;
  key: RetiredKey;
  inboxes: string[];
}

/**
 * Inside the deletion transaction, before `deleteFederationData`: the actor's key and follower
 * inboxes, or null when there is nobody to tell (flag off, no actor, no followers).
 */
export async function captureRetiredActor(
  tx: Executor,
  channelId: string,
  cfg: Pick<FederationConfig, "enabled">,
): Promise<RetiredActor | null> {
  if (!cfg.enabled) return null;
  const [actor] = await tx
    .select({ keyId: s.federationActors.keyId, privateKeyEnc: s.federationActors.privateKeyEnc })
    .from(s.federationActors)
    .where(eq(s.federationActors.channelId, channelId));
  if (!actor) return null;
  const inboxes = await followerInboxes(tx, channelId);
  return inboxes.length > 0 ? { channelId, key: actor, inboxes } : null;
}

/** After the commit: stash the key and queue the `Delete` deliveries. Returns how many were queued. */
export async function sendRetiredActorDelete(
  ctx: Pick<WorkerContext, "valkey" | "enqueueBulk">,
  cfg: Pick<FederationConfig, "site">,
  retired: RetiredActor,
): Promise<number> {
  await ctx.valkey.set(
    retiredKeyStashKey(retired.channelId),
    JSON.stringify(retired.key satisfies RetiredKey),
    "EX",
    RETIRED_KEY_TTL_SECONDS,
  );
  const urls = actorUrls(cfg.site.publicUrl, retired.channelId);
  return enqueueDeliveries(ctx, retired.channelId, null, deleteActorActivity(urls), retired.inboxes);
}

export async function deleteFederationData(tx: Executor, channelId: string): Promise<Record<string, number>> {
  const followers = await tx
    .delete(s.federationFollowers)
    .where(eq(s.federationFollowers.channelId, channelId))
    .returning({ id: s.federationFollowers.id });
  const actors = await tx
    .delete(s.federationActors)
    .where(eq(s.federationActors.channelId, channelId))
    .returning({ id: s.federationActors.channelId });
  await tx
    .update(s.channels)
    .set({ federationSettings: { enabled: false } })
    .where(eq(s.channels.id, channelId));
  return { federation_followers: followers.length, federation_actors: actors.length };
}
