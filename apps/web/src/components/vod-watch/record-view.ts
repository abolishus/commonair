// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Counting a play (D5.5): the watch pages call `vods.recordView` / `clips.recordView` once the
 * player reports that playback started, never on load. The server dedupes per viewer per day;
 * this only stops one page view from asking twice (a replay, a seek back to 0). Best effort: a
 * failure is not the viewer's problem and shows nothing.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";

export type ViewKind = "vod" | "clip";
export type RecordView = (kind: ViewKind, id: string) => Promise<unknown>;

export const recordViewApi: RecordView = (kind, id) =>
  kind === "vod" ? api().vods.recordView({ id }) : api().clips.recordView({ id });

/** A callback that records one play of `kind`/`id` the first time it is called (per id). */
export function useRecordView(record: RecordView, kind: ViewKind, id: string): () => void {
  const sent = React.useRef<string | null>(null);
  const recordRef = React.useRef(record);
  React.useEffect(() => {
    recordRef.current = record;
  }, [record]);
  return React.useCallback(() => {
    const key = `${kind}:${id}`;
    if (sent.current === key) return;
    sent.current = key;
    void Promise.resolve()
      .then(() => recordRef.current(kind, id))
      .catch(() => undefined);
  }, [kind, id]);
}
