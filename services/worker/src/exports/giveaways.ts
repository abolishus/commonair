// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaways in the account export (batch 8 contract step §3.6). B8-server fills it: the member's
 * own entries and wins, never another member's pseudonym or the salt. Until then the file is an
 * empty array.
 */
import type { ExportFile } from "./collectors.ts";

export const GIVEAWAY_EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "interact-giveaways.json",
    kind: "account",
    sections: {},
    combine: () => [],
  },
];
