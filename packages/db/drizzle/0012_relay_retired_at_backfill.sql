-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Before 0011, `relays.remove` retired a relay by rotating its token and setting it offline, and no
-- offline relay could authenticate. Mark those rows retired so they leave `relays.mine` and the
-- per-member relay limit now that offline relays may rejoin.
UPDATE "relay_nodes" SET "retired_at" = "updated_at"
 WHERE "status" = 'offline' AND "retired_at" IS NULL;
