// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who may see a VOD or clip. Every removal (T0, NCII, account deletion, retention) sets
 * `status = 'deleted'`; an owner or creator removal (E6) sets `removed_reason` at once and the
 * worker deletes the objects later; a T1-restricted broadcast's VODs and clips stay unlisted until
 * its case is cleared (docs/testing/e4c-selectors.md "T1 live"). None of these is shown to anyone,
 * the owner included. Beyond that the owner sees their own processing, failed, private and
 * subscriber-only items; an active subscriber also sees the channel's ready `subscribers` VODs;
 * everyone else sees only ready, public items of a channel that is not suspended. Media of a mature
 * broadcast, channel or category is listed, but its URLs go only to the owner and to signed-in,
 * 18+-confirmed viewers, as for live playback.
 */
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import type { Caller } from "../lib/access.ts";
import { confirmedAdult } from "../routes/me.ts";

const { broadcasts, categories, clips, subscriptions, vods } = schema;

export type Audience = "owner" | "subscriber" | "public";

/** `removed_reason` of a VOD or clip its channel owner or its creator deleted (E6). */
export const OWNER_REMOVED_REASONS = ["owner", "creator"] as const;
const ownerRemoved = (reason: string | null) => (OWNER_REMOVED_REASONS as readonly string[]).includes(reason ?? "");

/** Owner or not, without a database read: enough wherever subscriber-only VODs play no part. */
export function audienceOf(caller: Caller | null, channel: { ownerId: string }): Audience {
  return caller !== null && caller.user.id === channel.ownerId ? "owner" : "public";
}

/** The owner, an active subscriber of the channel, or the public. */
export async function viewerAudience(
  deps: Deps,
  caller: Caller | null,
  channel: { id: string; ownerId: string },
): Promise<Audience> {
  if (audienceOf(caller, channel) === "owner") return "owner";
  if (!caller) return "public";
  const [sub] = await deps.db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.channelId, channel.id),
        eq(subscriptions.subscriberId, caller.user.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .limit(1);
  return sub ? "subscriber" : "public";
}

const VIEWABLE: Record<Exclude<Audience, "owner">, readonly ("public" | "subscribers")[]> = {
  subscriber: ["public", "subscribers"],
  public: ["public"],
};

/** Filter for `vods` joined with its broadcast (inner join: a VOD always has one). */
export function vodVisible(audience: Audience): SQL {
  const always = and(
    ne(vods.status, "deleted"),
    isNull(broadcasts.restrictedAt),
    sql`coalesce(${vods.removedReason}, '') not in ('owner', 'creator')`,
  ) as SQL;
  if (audience === "owner") return always;
  return and(always, eq(vods.status, "ready"), inArray(vods.visibility, [...VIEWABLE[audience]])) as SQL;
}

/**
 * A clip carries its source's content: when a VOD of the clip's broadcast (or the VOD it was cut
 * from) was removed for anything but retention, the clip is hidden too. Removal paths delete such
 * clips themselves; this also covers clips cut from the live buffer, which have no `vod_id`.
 */
const sourceRemoved = sql`exists (select 1 from ${vods} where (${vods.id} = ${clips.vodId} or ${vods.broadcastId} = ${clips.broadcastId}) and ((${vods.status} = 'deleted' and ${vods.removedReason} is distinct from 'retention') or ${vods.removedReason} in ('owner', 'creator')))`;

/** Filter for `clips` left-joined with its broadcast (the broadcast may be gone). */
export function clipVisible(audience: Audience): SQL {
  const always = and(
    ne(clips.status, "deleted"),
    isNull(broadcasts.restrictedAt),
    sql`coalesce(${clips.removedReason}, '') not in ('owner', 'creator')`,
    sql`not ${sourceRemoved}`,
  ) as SQL;
  if (audience === "owner") return always;
  return and(always, eq(clips.status, "ready")) as SQL;
}

/** The VOD rules for one row already loaded with its channel and broadcast restriction. */
export function vodShown(
  audience: Audience,
  v: { status: string; visibility: string; removedReason: string | null },
  channel: { suspendedAt: Date | null },
  restrictedAt: Date | null,
): boolean {
  if (v.status === "deleted" || ownerRemoved(v.removedReason) || restrictedAt !== null) return false;
  if (audience === "owner") return true;
  return (
    channel.suspendedAt === null &&
    v.status === "ready" &&
    (VIEWABLE[audience] as readonly string[]).includes(v.visibility)
  );
}

type Labelled = { mature: boolean; categoryId: string | null };

/**
 * For each broadcast (null when it is gone), whether its media URLs must be withheld from this
 * caller: the broadcast, channel or a category is mature and the caller is neither the owner nor a
 * confirmed adult. One category query per call.
 */
export async function urlsWithheld(
  deps: Deps,
  caller: Caller | null,
  channel: Labelled & { ownerId: string },
  items: readonly (Labelled | null)[],
): Promise<boolean[]> {
  if (audienceOf(caller, channel) === "owner") return items.map(() => false);
  const ids = [channel.categoryId, ...items.map((b) => b?.categoryId ?? null)].filter((x): x is string => x !== null);
  const mature = new Set(
    ids.length === 0
      ? []
      : (
          await deps.db
            .select({ id: categories.id })
            .from(categories)
            .where(and(inArray(categories.id, [...new Set(ids)]), eq(categories.mature, true)))
        ).map((r) => r.id),
  );
  const labelled = (x: Labelled | null) =>
    x !== null && (x.mature || (x.categoryId !== null && mature.has(x.categoryId)));
  const gated = items.map((b) => labelled(channel) || labelled(b));
  if (!gated.some(Boolean)) return gated;
  if (await confirmedAdult(deps, caller?.user.id)) return items.map(() => false);
  return gated;
}
