// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live cues in Valkey (`CAPTIONS_KEYS`, ADR 0011): a sorted set per track and the live track
 * record the origin serves from. Both keys get `LIVE_TTL_SECONDS` on every write, so a crashed
 * host's transcript expires on its own. Only masked text reaches here.
 */
import type { Valkey } from "iovalkey";
import {
  CAPTIONS_KEYS,
  decodeCue,
  decodeLiveTrack,
  encodeCue,
  LIVE_TTL_SECONDS,
  type Cue,
  type LiveTrack,
} from "@commonair/captions";

export class LiveCueStore {
  constructor(private readonly valkey: Valkey) {}

  async track(broadcastId: string): Promise<LiveTrack | null> {
    return decodeLiveTrack(await this.valkey.get(CAPTIONS_KEYS.live(broadcastId)));
  }

  /** Append `cues` (numbered from `firstN`) and publish the track as transcribed through `track.throughMs`. */
  async append(broadcastId: string, track: LiveTrack, cues: readonly Cue[], firstN: number): Promise<void> {
    const cueKey = CAPTIONS_KEYS.cues(broadcastId, track.language);
    const m = this.valkey.multi();
    if (cues.length > 0) m.zadd(cueKey, ...cues.flatMap((c, i) => [String(c.startMs), encodeCue(firstN + i, c)]));
    m.expire(cueKey, LIVE_TTL_SECONDS);
    m.set(CAPTIONS_KEYS.live(broadcastId), JSON.stringify(track), "EX", LIVE_TTL_SECONDS);
    const res = await m.exec();
    const failed = res?.find(([err]) => err !== null);
    if (failed?.[0]) throw failed[0];
  }

  /** Every cue of a track, in time order. */
  async all(broadcastId: string, language: string): Promise<Cue[]> {
    const raw = await this.valkey.zrange(CAPTIONS_KEYS.cues(broadcastId, language), 0, -1);
    return raw.map(decodeCue).filter((c): c is Cue => c !== null);
  }

  async count(broadcastId: string, language: string): Promise<number> {
    return this.valkey.zcard(CAPTIONS_KEYS.cues(broadcastId, language));
  }

  /** The track stops being advertised (its cues stay until `drop` or their TTL). */
  async deactivate(broadcastId: string): Promise<void> {
    await this.valkey.del(CAPTIONS_KEYS.live(broadcastId));
  }

  async drop(broadcastId: string, language: string): Promise<void> {
    await this.valkey.del(CAPTIONS_KEYS.live(broadcastId), CAPTIONS_KEYS.cues(broadcastId, language));
  }
}
