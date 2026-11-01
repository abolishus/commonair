// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

export interface WatchRoomEvidenceProps {
  reportId: string;
  /**
   * `Report.evidence` of a `watch_room` report: the room's messages (author ids, body, time) and
   * members (ids, joined and left), copied at report time. Authors are shown by username through
   * the user lookup, never stored in the report.
   */
  evidence: Record<string, unknown>;
}

/**
 * A watch-room report's transcript and member list in the mod queue's report detail (ADR 0017).
 * Stub from the batch 7 contract step: W3-watch-rooms fills it
 * (`apps/web/src/components/safety/watch-room-evidence*`).
 */
export function WatchRoomEvidence(_props: WatchRoomEvidenceProps): React.JSX.Element | null {
  return null;
}
