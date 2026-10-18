// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stream-key leak response. When an active key shows up in public text (chat,
 * panels, the channel description) it is revoked and the owner is notified.
 * The chat service calls `revokeLeakedKey` (via the API package) for each
 * secret `findLeakedKeys` finds in a message.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { InstanceSite } from "@commonair/config/site";
import { sha256Hex } from "@commonair/tokens";
import { audit } from "../events/audit.ts";
import { appUrl, sendNotice, type Mailer } from "../mail.ts";
import { findLeakedKeys, isStreamKeySecret } from "./streamkeys.ts";

export { findLeakedKeys, redactKeys } from "./streamkeys.ts";

export interface LeakDeps {
  db: Database;
  mailer: Mailer;
  site: InstanceSite;
  logger: Logger;
  now: () => Date;
}

export type LeakSource = "chat" | "panel" | "description";

/** Revoke the active key matching `secret`. Returns the affected channel id, or null if no active key matched. */
export async function revokeLeakedKey(deps: LeakDeps, secret: string, source: LeakSource): Promise<string | null> {
  if (!isStreamKeySecret(secret)) return null;
  const hash = await sha256Hex(secret);
  const now = deps.now();
  const revoked = await deps.db.transaction(async (tx) => {
    const [key] = await tx
      .update(schema.streamKeys)
      .set({ revokedAt: now, revokedReason: `leaked:${source}` })
      .where(and(eq(schema.streamKeys.keyHash, hash), isNull(schema.streamKeys.revokedAt)))
      .returning({ id: schema.streamKeys.id, channelId: schema.streamKeys.channelId });
    if (!key) return null;
    const [channel] = await tx
      .select({ ownerId: schema.channels.ownerId })
      .from(schema.channels)
      .where(eq(schema.channels.id, key.channelId));
    if (!channel) return null;
    await tx.insert(schema.notifications).values({
      userId: channel.ownerId,
      type: "system",
      payload: { kind: "stream_key_leaked", streamKeyId: key.id, source },
    });
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "stream_key.revoke_leaked",
      subjectType: "stream_key",
      subjectId: key.id,
      channelId: key.channelId,
      details: { source },
    });
    return { ...key, ownerId: channel.ownerId };
  });
  if (!revoked) return null;
  const [owner] = await deps.db
    .select({ email: schema.users.email, locale: schema.users.locale, channelName: schema.channels.displayName })
    .from(schema.users)
    .innerJoin(schema.channels, eq(schema.channels.ownerId, schema.users.id))
    .where(eq(schema.users.id, revoked.ownerId));
  if (owner)
    await sendNotice(deps.logger, "streamKeyRevoked", () =>
      deps.mailer.send(
        "streamKeyRevoked",
        {
          channelName: owner.channelName,
          detectedAt: now,
          foundIn: source,
          streamKeysUrl: appUrl(deps.site, "/dashboard/stream"),
          locale: owner.locale,
        },
        owner.email,
      ),
    );
  deps.logger.warn("revoked leaked stream key", { channelId: revoked.channelId, source });
  return revoked.channelId;
}

/** Scan text and revoke every active key in it. Returns how many keys were revoked. */
export async function scanAndRevoke(deps: LeakDeps, text: string, source: LeakSource): Promise<number> {
  let n = 0;
  for (const secret of findLeakedKeys(text)) if (await revokeLeakedKey(deps, secret, source)) n++;
  return n;
}
