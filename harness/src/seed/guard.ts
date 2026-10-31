// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why the full seed may refuse to run. It writes append-only rows (ledger, votes, audit) that only
 * a database reset removes, so it runs only where all three hold: the operator opted in
 * (`DEMO_SEED_FULL=true`), named the exact target (`--confirm host:port/db`, so a stray
 * DATABASE_URL cannot be seeded by accident), and the database has no users at all (a fresh or
 * reset database: a real instance always has some).
 */
export interface GuardInput {
  seedFull: boolean;
  databaseUrl: string | undefined;
  confirm: string | undefined;
  /** Users in the target database (any kind, demo included). */
  userCount: number;
}

/** `host:port/database` of a connection URL, without credentials. */
export function describeTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
}

/** The reasons to refuse, empty when seeding may go ahead. Pure. */
export function fullSeedRefusals(i: GuardInput): string[] {
  const out: string[] = [];
  if (!i.seedFull) out.push("DEMO_SEED_FULL is not true (local and staging only)");
  if (!i.databaseUrl) {
    out.push("DATABASE_URL is not set");
    return out;
  }
  const target = describeTarget(i.databaseUrl);
  if (i.confirm !== target) out.push(`pass --confirm ${target} to seed this database`);
  if (i.userCount > 0)
    out.push(`the database has ${i.userCount} user(s); the full seed needs a fresh or reset database`);
  return out;
}
