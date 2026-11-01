// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.captions.{get,update}` (ADR 0011).
 *
 * - `get` follows the VOD's visibility (`vodShown` for the caller's audience) and its mature gate
 *   (`urlsWithheld`): whoever may not see the VOD's media gets NOT_FOUND, not its transcript.
 * - `update` is the channel owner's or an editor's. It changes cue text only (timing is fixed in
 *   v1), re-applies the channel's mask list, rewrites the stored `.vtt` and records who corrected
 *   how many cues in `caption_edits` (user id and a count; never the text) and the audit log.
 *   Unchanged cues are not an edit; a request that changes nothing records nothing.
 * - A correction never races a placement move (`services/worker/src/vod/placement.ts`): the move
 *   copies outside any lock and then switches `storage_prefix` under the VOD's row lock, so an
 *   update holds that lock across its read and write, and refuses while the VOD's objects are not
 *   where its state puts them (a move is pending or copying). Otherwise the move would carry the
 *   old track to the new prefix and delete the corrected one.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { parseVtt, vodVttDocument, type VodTrack } from "@commonair/captions";
import type { dto } from "@commonair/contracts";
import { isVodOwnPrefix, vodCaptionsKey, vodPlacement, vodPrefix } from "@commonair/contracts/storage";
import { schema } from "@commonair/db";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { captionsSettingsOf } from "../channels/media-settings.ts";
import { audit } from "../events/audit.ts";
import { channelAuthority, type Caller, type ChannelRole } from "../lib/access.ts";
import { iso } from "../lib/dto.ts";
import { badRequest, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { urlsWithheld, viewerAudience, vodShown } from "../media/visibility.ts";
import { maskWith } from "./mask.ts";

const { broadcastCaptionTracks: tracks, captionEdits, broadcasts, channels, channelRoles, vods } = schema;
type VodCaptions = z.infer<typeof dto.VodCaptions>;
type TrackRow = typeof tracks.$inferSelect;
type VodRow = typeof vods.$inferSelect;

async function vodWithChannel(deps: Deps, id: string) {
  const [row] = await deps.db
    .select({ v: vods, channel: channels, b: broadcasts })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .where(eq(vods.id, id))
    .limit(1);
  return row ?? null;
}

async function trackOf(deps: Deps, v: VodRow, language: string): Promise<TrackRow | null> {
  const [t] = await deps.db
    .select()
    .from(tracks)
    .where(and(eq(tracks.broadcastId, v.broadcastId), eq(tracks.language, language)))
    .limit(1);
  return t ?? null;
}

async function readTrack(deps: Deps, v: Pick<VodRow, "storagePrefix">, language: string): Promise<VodTrack> {
  const res = await deps.storage.get(deps.env.S3_BUCKET_MEDIA, vodCaptionsKey(v.storagePrefix, language));
  const parsed = res ? parseVtt(await res.text()) : null;
  if (!parsed) throw precondition("captions_ready", "This VOD's captions are not available");
  return parsed;
}

async function lastEditAt(deps: Deps, trackId: string): Promise<string | null> {
  const [e] = await deps.db
    .select({ at: captionEdits.createdAt })
    .from(captionEdits)
    .where(eq(captionEdits.trackId, trackId))
    .orderBy(desc(captionEdits.createdAt))
    .limit(1);
  return e ? iso(e.at) : null;
}

function toDto(
  v: VodRow,
  language: string,
  t: TrackRow | null,
  track: VodTrack | null,
  editedAt: string | null,
): VodCaptions {
  return {
    vodId: v.id,
    language,
    status: t?.status ?? "deleted",
    cues: (track?.cues ?? []).map((c, index) => ({
      index,
      startMs: Math.round(c.startMs),
      endMs: Math.round(c.endMs),
      text: c.text.slice(0, 500),
    })),
    editedAt,
  };
}

/** The owner or an editor of the VOD's channel; anything else is NOT_FOUND (as `vods.update`). */
async function managedVod(deps: Deps, caller: Caller, id: string) {
  const row = await vodWithChannel(deps, id);
  if (!row) throw notFound("VOD not found");
  const roles: ChannelRole[] =
    row.channel.ownerId === caller.user.id
      ? []
      : (
          await deps.db
            .select({ role: channelRoles.role })
            .from(channelRoles)
            .where(and(eq(channelRoles.channelId, row.channel.id), eq(channelRoles.userId, caller.user.id)))
        ).map((r) => r.role);
  const authority = channelAuthority(caller, row.channel, roles);
  if (authority !== "owner" && authority !== "editor") throw notFound("VOD not found");
  if (!vodShown("owner", row.v, row.channel, row.b.restrictedAt)) throw notFound("VOD not found");
  return row;
}

export const vodCaptions = {
  get: os.vods.captions.get.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const row = await vodWithChannel(deps, input.id);
    if (!row || !vodShown(await viewerAudience(deps, caller, row.channel), row.v, row.channel, row.b.restrictedAt))
      throw notFound("VOD not found");
    const [withheld] = await urlsWithheld(deps, caller, row.channel, [row.b]);
    if (withheld ?? true) throw notFound("VOD not found");
    const t = await trackOf(deps, row.v, input.language);
    if (!t) throw notFound("No captions in that language");
    const ready = t.status === "ready" && row.v.status === "ready";
    const track = ready ? await readTrack(deps, row.v, input.language) : null;
    return toDto(row.v, input.language, t, track, await lastEditAt(deps, t.id));
  }),

  update: os.vods.captions.update.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await managedVod(deps, caller, input.id);
    const seen = new Set<number>();
    for (const c of input.cues) {
      if (seen.has(c.index)) throw badRequest("Each cue may be changed once per request");
      seen.add(c.index);
    }
    const mask = maskWith(captionsSettingsOf(row.channel).maskWords);
    return deps.db.transaction(async (tx) => {
      // Locked first, in the move's own order (vods, then nothing else of the move's).
      const [locked] = await tx
        .select({
          v: vods,
          broadcastRestricted: sql<boolean>`${broadcasts.restrictedAt} is not null`,
          channelSuspended: sql<boolean>`${channels.suspendedAt} is not null`,
        })
        .from(vods)
        .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
        .innerJoin(channels, eq(channels.id, vods.channelId))
        .where(eq(vods.id, row.v.id))
        .for("update", { of: vods });
      if (!locked) throw notFound("VOD not found");
      const v = locked.v;
      const placement = vodPlacement({
        status: v.status,
        visibility: v.visibility,
        removedReason: v.removedReason,
        broadcastRestricted: locked.broadcastRestricted,
        channelSuspended: locked.channelSuspended,
        // NCII- and DMCA-hidden VODs keep their objects under moderation prefixes: refused just below.
        nciiHidden: false,
        dmcaHidden: false,
      });
      const settled =
        v.storagePrefix === row.v.storagePrefix &&
        isVodOwnPrefix(v.id, v.storagePrefix) &&
        (placement === "leave" || v.storagePrefix === vodPrefix(v.id, placement));
      if (!settled) throw precondition("captions_settled", "This VOD is being moved; try again in a moment");
      const [t] = await tx
        .select()
        .from(tracks)
        .where(and(eq(tracks.broadcastId, row.v.broadcastId), eq(tracks.language, input.language)))
        .for("update")
        .limit(1);
      if (!t) throw notFound("No captions in that language");
      if (t.status !== "ready" || v.status !== "ready")
        throw precondition("captions_ready", "These captions cannot be corrected yet");
      const track = await readTrack(deps, v, input.language);
      let changed = 0;
      for (const edit of input.cues) {
        const cue = track.cues[edit.index];
        if (!cue) throw badRequest(`No cue ${edit.index}`);
        // Whitespace only: `[…]` the creator typed (or the mask token) is text here, not whisper markup.
        const text = mask(edit.text.replace(/\s+/gu, " ").trim());
        if (text === cue.text) continue;
        cue.text = text;
        changed++;
      }
      if (changed === 0) return toDto(v, input.language, t, track, await lastEditAt(deps, t.id));
      // Under the row lock: a move cannot switch the prefix until this commits, and none is copying.
      const key = vodCaptionsKey(v.storagePrefix, input.language);
      await deps.storage.put(deps.env.S3_BUCKET_MEDIA, key, vodVttDocument(track), {
        contentType: "text/vtt; charset=utf-8",
      });
      const [edit] = await tx
        .insert(captionEdits)
        .values({ trackId: t.id, editorUserId: caller.user.id, cuesChanged: changed })
        .returning({ at: captionEdits.createdAt });
      await tx.update(tracks).set({ updatedAt: deps.now() }).where(eq(tracks.id, t.id));
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "vod.captions.update",
        subjectType: "vod",
        subjectId: v.id,
        channelId: v.channelId,
        details: { language: input.language, cuesChanged: changed },
      });
      return toDto(v, input.language, t, track, edit ? iso(edit.at) : null);
    });
  }),
};
