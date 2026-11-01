// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SegmentFetch } from "@commonair/contracts/internal";
import type { FetchRecord } from "@commonair/integrity";

/**
 * Segment-stream entries that are integrity evidence for a session. Relay and CDN entries
 * describe what the origin served a relay or CDN token, not what a viewer fetched, so they
 * never count (relay sessions are judged on receipts; CDN sessions are not judged on fetches).
 * `obj` becomes the object id, so re-requesting a segment cannot inflate the count.
 */
export function fetchEvidence(fetches: readonly SegmentFetch[]): FetchRecord[] {
  return fetches
    .filter((f) => f.src !== "relay" && f.src !== "cdn")
    .map((f) => ({
      sid: f.sid,
      kind: f.kind,
      ...(f.obj ? { object: f.obj } : {}),
      // ADR 0016 decision 6: `/dvr/` fetches are counted apart (absent = live).
      ...(f.mode === "dvr" ? { mode: "dvr" as const } : {}),
    }));
}
