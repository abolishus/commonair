// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a VOD's objects can be (ADR 0009 amendment 1). Readers list from the row's
 * `storage_prefix`, but a `vod-placement` move in flight has copies under both of the VOD's own
 * prefixes, so whatever must find every object (T0 evidence, NCII, DMCA, deletion) lists both.
 */
import { isVodOwnPrefix, vodPrefix } from "@commonair/contracts/storage";

/** The VOD's own prefixes, its `storage_prefix` first. A prefix it does not own is never returned. */
export function vodObjectPrefixes(vodId: string, storagePrefix: string | null | undefined): string[] {
  const both = [vodPrefix(vodId, "public"), vodPrefix(vodId, "private")];
  if (!storagePrefix || !isVodOwnPrefix(vodId, storagePrefix)) return both;
  return [storagePrefix, ...both.filter((p) => p !== storagePrefix)];
}

/** The VOD's other own prefix (where an interrupted move may have left copies). */
export const otherVodPrefix = (vodId: string, prefix: string): string =>
  prefix === vodPrefix(vodId, "public") ? vodPrefix(vodId, "private") : vodPrefix(vodId, "public");

/** A key under `from` rebased under `to`; keys outside `from` are returned unchanged. */
export const rebaseKey = (key: string, from: string, to: string): string =>
  key.startsWith(from) ? to + key.slice(from.length) : key;
