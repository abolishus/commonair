// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who may see a VOD or clip. Every removal (T0, NCII, account deletion, retention) sets
 * `status = 'deleted'`, and a T1-restricted broadcast's VODs and clips stay unlisted until its case
 * is cleared (docs/testing/e4c-selectors.md "T1 live"); neither is shown to anyone, the owner
 * included. Beyond that the owner sees their own processing, failed and non-public items; everyone
 * else sees only ready, public items of a channel that is not suspended. Media of a mature
 * broadcast, channel or category is listed, but its URLs go only to the owner and to signed-in,
 * 18+-confirmed viewers, as for live playback.
 */
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import type { Caller } from "../lib/access.ts";
import { confirmedAdult } from "../routes/me.ts";

const { broadcasts, categories, clips, vods } = schema;

export type Audience = "owner" | "public";

export function audienceOf(caller: Caller | null, channel: { ownerId: string }): Audience {
  return caller !== null && caller.user.id === channel.ownerId ? "owner" : "public";
}

/** Filter for `vods` joined with its broadcast (inner join: a VOD always has one). */
export function vodVisible(audience: Audience): SQL {
  const always = and(ne(vods.status, "deleted"), isNull(broadcasts.restrictedAt)) as SQL;
  if (audience === "owner") return always;
  return and(always, eq(vods.status, "ready"), eq(vods.visibility, "public")) as SQL;
}

/**
 * A clip carries its source's content: when a VOD of the clip's broadcast (or the VOD it was cut
 * from) was removed for anything but retention, the clip is hidden too. Removal paths delete such
 * clips themselves; this also covers clips cut from the live buffer, which have no `vod_id`.
 */
const sourceRemoved = sql`exists (select 1 from ${vods} where (${vods.id} = ${clips.vodId} or ${vods.broadcastId} = ${clips.broadcastId}) and ${vods.status} = 'deleted' and ${vods.removedReason} is distinct from 'retention')`;

/** Filter for `clips` left-joined with its broadcast (the broadcast may be gone). */
export function clipVisible(audience: Audience): SQL {
  const always = and(ne(clips.status, "deleted"), isNull(broadcasts.restrictedAt), sql`not ${sourceRemoved}`) as SQL;
  if (audience === "owner") return always;
  return and(always, eq(clips.status, "ready")) as SQL;
}

/** The VOD rules for one row already loaded with its channel and broadcast restriction. */
export function vodShown(
  audience: Audience,
  v: { status: string; visibility: string },
  channel: { suspendedAt: Date | null },
  restrictedAt: Date | null,
): boolean {
  if (v.status === "deleted" || restrictedAt !== null) return false;
  if (audience === "owner") return true;
  return channel.suspendedAt === null && v.status === "ready" && v.visibility === "public";
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
