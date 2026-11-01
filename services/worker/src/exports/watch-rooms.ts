// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms in the account export (ADR 0017): the member's own rooms and messages that still
 * exist. Owned by W3-watch-rooms; registered in `EXPORT_FILES` by the batch 7 contract step. A stub
 * with no sections until the unit lands (the file is then `{}`).
 */
import type { ExportFile } from "./collectors.ts";

export const WATCH_ROOM_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "watch-rooms.json",
    kind: "account",
    sections: {},
  },
];
