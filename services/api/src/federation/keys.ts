// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Actor keys (ADR 0030 decision 4): RSA-2048 from `generateActorKey`, the private key stored with
 * `encryptSecret` under the federation purpose and never logged. Rotation keeps the key id
 * (`<actor>#main-key`), appends the retired public key to `federation_actor_keys` (append-only,
 * not served), writes an audit row, and queues the `rotate` job, which sends `Update{Service}`.
 * Split of work with the worker: here the key is stored and audited; a `rotate` job with a
 * `channelId` only sends `Update`, and one without does the yearly sweep (and audits it itself).
 */
import { generateActorKey } from "@commonair/federation";
import { schema, uuidv7 } from "@commonair/db";
import { encryptSecret } from "@commonair/tokens";
import { asc, eq } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { notFound } from "../lib/errors.ts";
import { actorUrl, keyIdOf } from "./ids.ts";
import { federationQueue } from "./queue.ts";

const { channels, federationActorKeys, federationActors } = schema;

/**
 * The `encryptSecret` purpose of actor private keys. N4-delivery decrypts with the same string
 * (contract request: export it from `packages/federation`).
 */
export const FEDERATION_KEY_PURPOSE = "federation";

export interface SealedActorKey {
  publicKeyPem: string;
  privateKeyEnc: string;
}

/** A fresh RSA-2048 pair; the private half leaves this function only encrypted. */
export async function newActorKey(authSecret: string): Promise<SealedActorKey> {
  const pair = await generateActorKey();
  return {
    publicKeyPem: pair.publicKeyPem,
    privateKeyEnc: await encryptSecret(authSecret, FEDERATION_KEY_PURPOSE, pair.privateKeyPem),
  };
}

/** Rotate one channel's key, or every actor's (`slug` omitted). Returns how many rotated. */
export async function rotateKeys(deps: Deps, adminId: string, slug: string | undefined): Promise<number> {
  let targets: { channelId: string }[];
  if (slug) {
    const [c] = await deps.db.select({ id: channels.id }).from(channels).where(eq(channels.slug, slug)).limit(1);
    if (!c) throw notFound("Channel not found");
    targets = await deps.db
      .select({ channelId: federationActors.channelId })
      .from(federationActors)
      .where(eq(federationActors.channelId, c.id));
  } else {
    // Every federating actor; a channel that is off rotates when named, or when it turns on again
    // and the yearly job finds its key old.
    targets = await deps.db
      .select({ channelId: federationActors.channelId })
      .from(federationActors)
      .where(eq(federationActors.enabled, true))
      .orderBy(asc(federationActors.channelId));
  }

  const rotated: { channelId: string; rotationId: string }[] = [];
  for (const { channelId } of targets) {
    // RSA generation is slow-ish; never inside the row lock.
    const fresh = await newActorKey(deps.env.AUTH_SECRET);
    const now = deps.now();
    const done = await deps.db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(federationActors)
        .where(eq(federationActors.channelId, channelId))
        .for("update");
      if (!old) return null;
      await tx.insert(federationActorKeys).values({
        channelId,
        keyId: old.keyId,
        publicKeyPem: old.publicKeyPem,
        keyCreatedAt: old.keyCreatedAt,
        retiredAt: now,
      });
      await tx
        .update(federationActors)
        .set({
          keyId: keyIdOf(actorUrl(deps.site, channelId)),
          publicKeyPem: fresh.publicKeyPem,
          privateKeyEnc: fresh.privateKeyEnc,
          keyCreatedAt: now,
          updatedAt: now,
        })
        .where(eq(federationActors.channelId, channelId));
      await audit(tx, {
        actorType: "admin",
        actorId: adminId,
        action: "federation.key.rotate",
        subjectType: "channel",
        subjectId: channelId,
        channelId,
        details: { scope: slug ? "channel" : "all", retiredKeyCreatedAt: old.keyCreatedAt.toISOString() },
      });
      return { channelId, rotationId: uuidv7(now.getTime()) };
    });
    if (done) rotated.push(done);
  }

  // After commit: a lost enqueue leaves the new key in place (served in the actor document) and is
  // logged; the yearly rotation job and any refetch on a failed verification recover from it.
  for (const r of rotated)
    await federationQueue(deps)
      .rotate(r.channelId, r.rotationId)
      .catch((err: unknown) =>
        deps.logger.error("federation rotate enqueue failed", { channelId: r.channelId, err: (err as Error).name }),
      );
  return rotated.length;
}
