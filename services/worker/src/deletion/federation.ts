// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion's federation step (ADR 0030): the deleted streamer's channel stops federating
 * in the deletion transaction. Its actor goes (with the private key) and so do its followers'
 * actor ids and inboxes, which are remote people's data. Public key history
 * (`federation_actor_keys`, append-only) and object ids stay: they hold no personal data.
 * `completeDeletion` merges the returned counts into its own.
 *
 * Owned by N4. Until N4 lands this only removes rows. N4 adds the `Delete` of the actor to every
 * follower inbox: it must capture what that needs (inboxes, and a signature or the key) inside
 * this transaction, before the rows below go, because a channel is pseudonymized, never deleted,
 * so no cascade ever removes them later.
 */
import { schema as s, type Executor } from "@commonair/db";
import { eq } from "drizzle-orm";

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
