-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Failure codes written to removed_reason before 0009 move to failed_reason (removals only there).
UPDATE "vods" SET "failed_reason" = "removed_reason", "removed_reason" = NULL
 WHERE "status" = 'failed' AND "removed_reason" IN ('no_segments', 'finalize_stalled');
