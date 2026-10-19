// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fixture anchors (`DEMO_FIXTURES` in contracts) as SQL. A user is demo data only when the
 * username has the reserved `demo_` prefix AND the email is on the `.invalid` fixture domain;
 * either anchor alone never qualifies. LIKE wildcards in the anchors are escaped, so `demo_`
 * does not match `demoX…`.
 */
import { type SQL, sql } from "drizzle-orm";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { users } from "../schema/auth.ts";

/** Escape `\`, `%` and `_` for a LIKE pattern with `escape '\'`. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const USERNAME_LIKE = `${likeEscape(DEMO_FIXTURES.usernamePrefix.toLowerCase())}%`;
export const EMAIL_LIKE = `%@${likeEscape(DEMO_FIXTURES.emailDomain.toLowerCase())}`;

/** WHERE clause selecting users that carry both anchors. */
export function anchoredUser(): SQL {
  return sql`(lower(${users.username}) like ${USERNAME_LIKE} escape '\\' and lower(${users.email}) like ${EMAIL_LIKE} escape '\\')`;
}

/** A demo identity for `handle` (e.g. `streamer1` → `demo_streamer1@demo-seed.invalid`). */
export function demoIdentity(handle: string): { username: string; email: string } {
  const username = `${DEMO_FIXTURES.usernamePrefix}${handle}`.toLowerCase();
  return { username, email: `${username}@${DEMO_FIXTURES.emailDomain}` };
}
