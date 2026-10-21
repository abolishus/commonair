// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The NCMEC draft snapshot (ADR 0006 Q3): what the CyberTipline asks for, sealed to the evidence
 * key. The one deliberate exception to "no personal data in retained rows": the legal duty to
 * report and preserve outranks deletion. It is built and sealed inside the T0 transaction and
 * never logged.
 */
import { NcmecSnapshot } from "@commonair/contracts/dto";
import { schema, type Executor } from "@commonair/db";
import { sealJson, type SealingKey } from "@commonair/moderation";
import { eq, isNotNull, and } from "drizzle-orm";

export interface SnapshotInput {
  userId: string;
  incidentAt: Date;
  incidentType: "csam_hash_match" | "csam_confirmed";
  subject: { type: NcmecSnapshot["subject"]["type"]; id: string; channelId: string | null };
  match: NcmecSnapshot["match"];
  evidenceIds: string[];
}

export async function buildSnapshot(tx: Executor, i: SnapshotInput): Promise<NcmecSnapshot> {
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, i.userId));
  if (!user) throw new Error("NCMEC snapshot: subject user not found");
  const channel = i.subject.channelId
    ? (await tx.select().from(schema.channels).where(eq(schema.channels.id, i.subject.channelId)))[0]
    : undefined;
  const sessions = await tx
    .select({ ip: schema.sessions.ipAddress })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, i.userId), isNotNull(schema.sessions.ipAddress)));
  const playback = await tx
    .selectDistinct({ h: schema.playbackSessions.ipHash })
    .from(schema.playbackSessions)
    .where(eq(schema.playbackSessions.userId, i.userId));
  const keys = channel
    ? await tx
        .select({ h: schema.streamKeys.lastUsedIpHash })
        .from(schema.streamKeys)
        .where(and(eq(schema.streamKeys.channelId, channel.id), isNotNull(schema.streamKeys.lastUsedIpHash)))
    : [];
  const ipHashes = [...new Set([...playback.map((p) => p.h), ...keys.map((k) => k.h)].filter((h): h is string => !!h))];
  const ips = [...new Set(sessions.map((s) => s.ip).filter((ip): ip is string => !!ip))];
  return NcmecSnapshot.parse({
    v: 1,
    incidentAt: i.incidentAt.toISOString(),
    incidentType: i.incidentType,
    account: {
      id: user.id,
      username: user.username,
      displayName: user.displayUsername ?? user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      ipHashes,
      ips,
    },
    subject: {
      type: i.subject.type,
      id: i.subject.id,
      channelId: i.subject.channelId,
      channelSlug: channel?.slug ?? null,
    },
    match: i.match,
    evidenceIds: i.evidenceIds,
  });
}

export async function sealSnapshot(key: SealingKey, snapshot: NcmecSnapshot): Promise<Uint8Array> {
  return sealJson(key, snapshot);
}
