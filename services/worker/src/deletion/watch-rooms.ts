// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion's watch-room step (ADR 0017): remove the user's room messages and memberships
 * and end the rooms they host, in the deletion transaction. `completeDeletion` merges the returned
 * counts into its own. Owned by W3-watch-rooms; a no-op stub until it lands (rows also go by
 * cascade when the user row itself is deleted).
 */
import type { Executor } from "@commonair/db";

export async function deleteRoomData(_tx: Executor, _userId: string): Promise<Record<string, number>> {
  return {};
}
