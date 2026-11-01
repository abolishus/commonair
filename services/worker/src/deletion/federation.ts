// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion's federation step (ADR 0030): the deleted streamer's channel stops federating
 * in the deletion transaction. Its actor goes (with the private key) and so do its followers'
 * actor ids and inboxes, which are remote people's data. Public key history
 * (`federation_actor_keys`, append-only) and object ids stay: they hold no personal data.
 * `completeDeletion` merges the returned counts into its own.
 *
 * Remote servers are told with `Delete` of the actor. Its deliveries run after the commit, but
 * the rows below are gone by then (a channel is pseudonymized, never deleted, so no cascade
 * removes them later), so with `deps` this step captures what they need inside the transaction:
 * the follower inboxes go into the queued `deliver` jobs, and the still-encrypted key is stashed in
 * Valkey (`retiredKeyStashKey`, a day's TTL, longer than every retry) for those jobs to sign
 * with. The stash and the jobs are written before the commit; should the transaction roll back,
 * the deletion runs again and sends the same `Delete` (stable id). Without `deps` (or with the
 * instance flag off) only the rows go.
 */
import { schema as s, type Executor } from "@commonair/db";
import { actorUrls, deleteActorActivity } from "@commonair/federation";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { FederationConfig } from "../federation/config.ts";
import { enqueueDeliveries, RETIRED_KEY_TTL_SECONDS, retiredKeyStashKey } from "../federation/deliver.ts";
import { followerInboxes } from "../federation/local.ts";

export interface FederationDeletionDeps {
  ctx: Pick<WorkerContext, "valkey" | "enqueueBulk">;
  cfg: Pick<FederationConfig, "enabled" | "site">;
}

export async function deleteFederationData(
  tx: Executor,
  channelId: string,
  deps?: FederationDeletionDeps,
): Promise<Record<string, number>> {
  let deliveries = 0;
  if (deps?.cfg.enabled) {
    const [actor] = await tx
      .select({
        keyId: s.federationActors.keyId,
        privateKeyEnc: s.federationActors.privateKeyEnc,
        enabled: s.federationActors.enabled,
      })
      .from(s.federationActors)
      .where(eq(s.federationActors.channelId, channelId));
    const inboxes = actor ? await followerInboxes(tx, channelId) : [];
    if (actor && inboxes.length > 0) {
      await deps.ctx.valkey.set(
        retiredKeyStashKey(channelId),
        JSON.stringify({ keyId: actor.keyId, privateKeyEnc: actor.privateKeyEnc }),
        "EX",
        RETIRED_KEY_TTL_SECONDS,
      );
      const urls = actorUrls(deps.cfg.site.publicUrl, channelId);
      deliveries = await enqueueDeliveries(deps.ctx, channelId, null, deleteActorActivity(urls), inboxes);
    }
  }
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
  return {
    federation_followers: followers.length,
    federation_actors: actors.length,
    ...(deps ? { federation_actor_deletes: deliveries } : {}),
  };
}
