// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portability in the data export (ADR 0037): the member's "tell me if they move" grants and
 * imports, and a channel's move links. Owned by W3-portability; registered in `EXPORT_FILES` by the
 * batch 7 contract step. A stub with no sections until the unit lands (the file is then `{}`).
 */
import type { ExportFile } from "../exports/collectors.ts";

export const PORTABILITY_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "portability.json",
    kind: "account",
    sections: {},
  },
];
