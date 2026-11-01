// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.*`. `flags` and `decide` (admins) live in `../admin/integrity.ts` (E7-admin);
 * `channelSummary` (W2-rollup-analytics) reads the per-broadcast rollup (`../analytics/queries.ts`),
 * owner only, under the same display delay and small-group suppression as analytics.
 *
 * Signed audience attestations (W2b-attestations, ADR 0014). Nothing here signs: the worker does,
 * and the API only reads and assembles (decision 6).
 *
 * - Publication follows analytics' 24 h display delay (decision 3): an entry shows once its
 *   broadcast ended 24 h ago, or at once under the harness's display bypass.
 * - `list`/`get`: the channel's owner sees the breakdown and salt that open the reasons
 *   commitment; an editor sees the public statement.
 * - `share`: an expiring link revealing the breakdown, checked against the commitment first. The
 *   token is shown once and stored as its SHA-256 only.
 * - `bundle`: the public window proof, contiguous entries from `fromSeq` (breakdown and salt null)
 *   plus the key history. It stops before the first entry not yet published, so it stays contiguous.
 * - `keys.compromise`: an audited admin action that marks the key and, in the same transaction,
 *   writes `integrity.key.compromised` naming every broadcast whose current entry it signed; the
 *   outbox relay enqueues a re-check of each, the worker re-issues them (`reissue`), and the daily
 *   reconciler catches anything that was lost.
 *
 * The public verifier and the well-known key history are `./attestation-verify.ts`.
 */
import type { AttestationEntry, AttestationShareLink } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";
import { reasonsCommitment } from "@commonair/tokens/attestation";
import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { decideFlag, listFlags } from "../admin/integrity.ts";
import { channelSummary } from "../analytics/queries.ts";
import { displayCutoff } from "../analytics/rules.ts";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, isOffsetCursor, pageOf } from "../lib/cursor.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { type Ctx, os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { analyticsDisplayBypassed } from "../ops/analytics-hooks.ts";
import { ownChannel, rangeOf } from "./analytics.ts";
import { type EntryRow, attestationKeys, attestationVerify, loadKeyHistory, toEntry } from "./attestation-verify.ts";

const { integrityAttestations: entries, attestationShareLinks: links, broadcasts, channels } = schema;
type LinkRow = typeof links.$inferSelect;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------------------- reads

/** Entries of a published broadcast only: ended past the display delay, unless bypassed. */
const published = (now: Date, bypassed: boolean) =>
  bypassed
    ? sql`${broadcasts.endedAt} is not null`
    : sql`${broadcasts.endedAt} is not null and ${broadcasts.endedAt} <= ${displayCutoff(now).toISOString()}::timestamptz`;

/**
 * A later entry of the same broadcast exists (at or before `maxSeq` when given). The outer columns
 * are spelled out qualified: drizzle leaves them bare in a one-table select, where they would bind
 * to the subquery's own rows.
 */
const supersededSql = (maxSeq: number | null) =>
  sql<boolean>`exists (select 1 from integrity_attestations x
     where x.channel_id = integrity_attestations.channel_id
       and x.broadcast_id = integrity_attestations.broadcast_id
       and x.seq > integrity_attestations.seq
     ${maxSeq === null ? sql`` : sql`and x.seq <= ${maxSeq}`})`;

/** The caller is the channel's owner (who sees breakdowns), not an editor. */
function viewerOf(context: Pick<Ctx, "caller" | "channel">) {
  const caller = requireCaller(context);
  const channel = requireChannel(context);
  return { channel, isOwner: channel.ownerId === caller.user.id };
}

async function listEntries(
  deps: Deps,
  q: { channelId: string; channelSlug: string; reveal: boolean; cursor?: string | undefined; limit: number },
) {
  const now = deps.now();
  const bypassed = await analyticsDisplayBypassed(deps, q.channelId);
  const after = decodeCursor(q.cursor, isOffsetCursor);
  // Newest first by seq; the cursor is the last seq served.
  const rows = await deps.db
    .select({ e: entries, superseded: supersededSql(null) })
    .from(entries)
    .innerJoin(broadcasts, eq(broadcasts.id, entries.broadcastId))
    .where(
      and(eq(entries.channelId, q.channelId), published(now, bypassed), after ? lt(entries.seq, after.o) : undefined),
    )
    .orderBy(desc(entries.seq))
    .limit(q.limit + 1);
  return pageOf(
    rows,
    q.limit,
    (r) => toEntry(r.e, { channelSlug: q.channelSlug, superseded: r.superseded, reveal: q.reveal }),
    (last) => encodeCursor({ o: last.e.seq }),
  );
}

/** One published entry of the channel, or NOT_FOUND (unknown, another channel's, or not yet published). */
async function publishedEntry(deps: Deps, channelId: string, id: string) {
  const bypassed = await analyticsDisplayBypassed(deps, channelId);
  const [row] = await deps.db
    .select({ e: entries, superseded: supersededSql(null) })
    .from(entries)
    .innerJoin(broadcasts, eq(broadcasts.id, entries.broadcastId))
    .where(and(eq(entries.id, id), eq(entries.channelId, channelId), published(deps.now(), bypassed)))
    .limit(1);
  if (!row) throw notFound("Attestation not found");
  return row;
}

/** The stored breakdown and salt must open the signed commitment before anyone is shown them. */
async function assertOpens(e: EntryRow): Promise<void> {
  const statement = JSON.parse(Buffer.from(e.payload, "base64url").toString("utf8")) as { reasonsCommitment?: unknown };
  if ((await reasonsCommitment(e.salt, e.breakdown)) !== statement.reasonsCommitment)
    throw new Error(`attestation ${e.id}: the stored breakdown does not open its commitment`);
}

/**
 * The public window: entries from `fromSeq`, oldest first, up to `limit`, stopping before the
 * first entry not yet published (so the window has no gap), plus the key history.
 */
export async function attestationBundle(deps: Deps, q: { channel: string; fromSeq: number; limit: number }) {
  const [channel] = await deps.db
    .select({ id: channels.id, slug: channels.slug })
    .from(channels)
    .where(eq(channels.slug, q.channel))
    .limit(1);
  if (!channel) throw notFound("Channel not found");
  const now = deps.now();
  const bypassed = await analyticsDisplayBypassed(deps, channel.id);
  const [cut] = await deps.db
    .select({ seq: sql<number | null>`min(${entries.seq})` })
    .from(entries)
    .innerJoin(broadcasts, eq(broadcasts.id, entries.broadcastId))
    .where(and(eq(entries.channelId, channel.id), gte(entries.seq, q.fromSeq), sql`not (${published(now, bypassed)})`));
  const until = cut?.seq ?? null;
  const rows = await deps.db
    .select({ e: entries, superseded: supersededSql(until === null ? null : until - 1) })
    .from(entries)
    .where(
      and(
        eq(entries.channelId, channel.id),
        gte(entries.seq, q.fromSeq),
        until === null ? undefined : lt(entries.seq, until),
      ),
    )
    .orderBy(asc(entries.seq))
    .limit(q.limit);
  return {
    entries: rows.map((r) => toEntry(r.e, { channelSlug: channel.slug, superseded: r.superseded, reveal: false })),
    keys: { origin: new URL(deps.site.publicUrl).origin, keys: await loadKeyHistory(deps.db) },
  };
}

// ------------------------------------------------------------------------------- share links

const trimSlash = (u: string) => u.replace(/\/+$/, "");
/** The link a recipient opens: the API's public JSON view of the shared attestation. */
export const attestationShareUrl = (deps: Pick<Deps, "env">, token: string) =>
  `${trimSlash(deps.env.API_PUBLIC_URL)}/api/attestations/shared/${encodeURIComponent(token)}`;

const toLink = (r: LinkRow, url: string | null = null): AttestationShareLink => ({
  id: r.id,
  attestationId: r.attestationId,
  url,
  expiresAt: r.expiresAt.toISOString(),
  revokedAt: r.revokedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

async function createLink(
  deps: Deps,
  q: { channelId: string; creatorId: string; id: string; expiresInDays: number },
): Promise<AttestationShareLink> {
  const { e } = await publishedEntry(deps, q.channelId, q.id);
  await assertOpens(e);
  const token = randomTokenSecret("", 24);
  const now = deps.now();
  const [row] = await deps.db
    .insert(links)
    .values({
      id: uuidv7(now.getTime()),
      attestationId: e.id,
      tokenHash: await sha256Hex(token),
      createdById: q.creatorId,
      expiresAt: new Date(now.getTime() + q.expiresInDays * DAY_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("attestation share link insert returned nothing");
  return toLink(row, attestationShareUrl(deps, token));
}

async function listLinks(deps: Deps, q: { channelId: string; cursor?: string | undefined; limit: number }) {
  const after = decodeCursor(q.cursor, isKeyCursor);
  const rows = await deps.db
    .select({ l: links })
    .from(links)
    .innerJoin(entries, eq(entries.id, links.attestationId))
    .where(
      and(
        eq(entries.channelId, q.channelId),
        after
          ? or(
              lt(links.createdAt, new Date(after.t)),
              and(eq(links.createdAt, new Date(after.t)), lt(links.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(links.createdAt), desc(links.id))
    .limit(q.limit + 1);
  return pageOf(
    rows,
    q.limit,
    (r) => toLink(r.l),
    (last) => encodeCursor({ t: last.l.createdAt.toISOString(), id: last.l.id }),
  );
}

/** Revoke one of the channel's links; revoking a revoked link again is a no-op. */
async function revokeLink(deps: Deps, q: { channelId: string; id: string }) {
  const [row] = await deps.db
    .select({ id: links.id, revokedAt: links.revokedAt })
    .from(links)
    .innerJoin(entries, eq(entries.id, links.attestationId))
    .where(and(eq(links.id, q.id), eq(entries.channelId, q.channelId)));
  if (!row) throw notFound("Share link not found");
  if (!row.revokedAt)
    await deps.db
      .update(links)
      .set({ revokedAt: deps.now() })
      .where(and(eq(links.id, q.id), isNull(links.revokedAt)));
  return { ok: true as const };
}

/** What a share link shows: the entry with its breakdown. NOT_FOUND for unknown, expired, revoked or unpublished. */
async function sharedEntry(deps: Deps, token: string): Promise<AttestationEntry> {
  const now = deps.now();
  const [link] = await deps.db
    .select({ attestationId: links.attestationId, channelId: entries.channelId, slug: channels.slug })
    .from(links)
    .innerJoin(entries, eq(entries.id, links.attestationId))
    .innerJoin(channels, eq(channels.id, entries.channelId))
    .where(and(eq(links.tokenHash, await sha256Hex(token)), isNull(links.revokedAt), gt(links.expiresAt, now)))
    .limit(1);
  if (!link) throw notFound("This link has expired or was revoked");
  const { e, superseded } = await publishedEntry(deps, link.channelId, link.attestationId).catch(() => {
    throw notFound("This link has expired or was revoked");
  });
  await assertOpens(e);
  return toEntry(e, { channelSlug: link.slug, superseded, reveal: true });
}

// ------------------------------------------------------------------------------- key compromise

async function compromiseKey(deps: Deps, adminId: string, q: { kid: string; reason: string }) {
  const k = schema.integritySigningKeys;
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select().from(k).where(eq(k.kid, q.kid)).for("update");
    if (!current) throw notFound("Signing key not found");
    if (current.compromisedAt) throw conflict("This key is already marked compromised");
    const [updated] = await tx.update(k).set({ compromisedAt: now }).where(eq(k.kid, q.kid)).returning();
    if (!updated) throw new Error("signing key update returned nothing");
    // Broadcasts whose current (latest) entry this key signed.
    const latest = await tx
      .select({ broadcastId: entries.broadcastId })
      .from(entries)
      .where(
        and(
          eq(entries.kid, q.kid),
          sql`${entries.seq} = (select max(x.seq) from ${entries} x where x.broadcast_id = ${entries.broadcastId})`,
        ),
      );
    await audit(tx, {
      actorType: "admin",
      actorId: adminId,
      action: "integrity.key.compromise",
      subjectType: "integrity_signing_key",
      subjectId: q.kid,
      reason: q.reason,
      details: { kid: q.kid, broadcasts: latest.length },
    });
    // The relay starts one re-issue per broadcast; the daily reconciler catches any it misses.
    await emit(tx, "integrity.key.compromised", null, {
      kid: q.kid,
      broadcast_ids: latest.map((r) => r.broadcastId),
    });
    return updated;
  });
  return {
    kid: row.kid,
    algorithm: "Ed25519" as const,
    publicKey: row.publicKey,
    firstUsedAt: row.firstUsedAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
    compromisedAt: row.compromisedAt?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------------------- handlers

export const integrity = {
  channelSummary: os.integrity.channelSummary.handler(async ({ context, input }) => {
    const { channel } = ownChannel(context);
    return channelSummary(context.deps, {
      ...(await rangeOf(context.deps, channel.id, input)),
      channelSlug: channel.slug,
    });
  }),
  flags: os.integrity.flags.handler(({ context, input }) => listFlags(context.deps, input)),
  decide: os.integrity.decide.handler(({ context, input }) =>
    decideFlag(context.deps, requireCaller(context).user.id, input),
  ),
  attestations: {
    list: os.integrity.attestations.list.handler(({ context, input }) => {
      const { channel, isOwner } = viewerOf(context);
      return listEntries(context.deps, {
        channelId: channel.id,
        channelSlug: channel.slug,
        reveal: isOwner,
        cursor: input.cursor,
        limit: input.limit,
      });
    }),
    get: os.integrity.attestations.get.handler(async ({ context, input }) => {
      const { channel, isOwner } = viewerOf(context);
      const { e, superseded } = await publishedEntry(context.deps, channel.id, input.id);
      if (isOwner) await assertOpens(e);
      return toEntry(e, { channelSlug: channel.slug, superseded, reveal: isOwner });
    }),
    share: os.integrity.attestations.share.handler(({ context, input }) => {
      const { caller, channel } = ownChannel(context);
      return createLink(context.deps, {
        channelId: channel.id,
        creatorId: caller.user.id,
        id: input.id,
        expiresInDays: input.expiresInDays,
      });
    }),
    shareLinks: {
      list: os.integrity.attestations.shareLinks.list.handler(({ context, input }) => {
        const { channel } = ownChannel(context);
        return listLinks(context.deps, { channelId: channel.id, cursor: input.cursor, limit: input.limit });
      }),
      revoke: os.integrity.attestations.shareLinks.revoke.handler(({ context, input }) => {
        const { channel } = ownChannel(context);
        return revokeLink(context.deps, { channelId: channel.id, id: input.id });
      }),
    },
    bundle: os.integrity.attestations.bundle.handler(({ context, input }) => attestationBundle(context.deps, input)),
    shared: os.integrity.attestations.shared.handler(({ context, input }) => sharedEntry(context.deps, input.token)),
    verify: attestationVerify,
  },
  keys: {
    list: attestationKeys,
    compromise: os.integrity.keys.compromise.handler(({ context, input }) =>
      compromiseKey(context.deps, requireCaller(context).user.id, input),
    ),
  },
};
