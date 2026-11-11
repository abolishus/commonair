// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `users.usernameAvailable` (overhaul wave 2, D2.4 claim field): whether a name can be claimed at
 * sign-up. It answers only taken, reserved or invalid, never who holds a name. The contract's
 * "auth" rate limit applies (per IP), so it cannot be used to enumerate accounts quickly.
 */
import { eq } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { usernameProblem } from "../auth/identity.ts";
import { os } from "../lib/orpc.ts";

export type UsernameAvailability = {
  username: string;
  available: boolean;
  reason: "taken" | "reserved" | "invalid" | null;
};

/** The same rules the sign-up gate applies (auth/index.ts), then the names already in use. */
export async function usernameAvailability(db: Executor, raw: string): Promise<UsernameAvailability> {
  const username = raw.trim().toLowerCase();
  const problem = usernameProblem(username);
  if (problem === "reserved") return { username, available: false, reason: "reserved" };
  if (problem) return { username, available: false, reason: "invalid" };
  // The username is also the channel slug, so a channel holding it blocks it too.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  const [channel] = user
    ? []
    : await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.slug, username))
        .limit(1);
  if (user || channel) return { username, available: false, reason: "taken" };
  return { username, available: true, reason: null };
}

export const usernameRoutes = {
  usernameAvailable: os.users.usernameAvailable.handler(({ context: { deps }, input }) =>
    usernameAvailability(deps.db, input.username),
  ),
};
