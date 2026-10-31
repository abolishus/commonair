// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The full seed's shared shapes. Contract-step owned: units read these and never change them. */
import type { DbHandle } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../env.ts";
import type { Rng } from "./prng.ts";
import type { SeedScale, SeedScaleName } from "./scale.ts";

export const SEED_UNIT_NAMES = ["social", "interact", "money", "coop", "safety", "platform", "media"] as const;
export type SeedUnitName = (typeof SEED_UNIT_NAMES)[number];

export type SeedAccountKind = "fixed" | "bulk-streamer" | "bulk-viewer" | "bot";

export interface SeededUser {
  id: string;
  /** Without the `demo_` prefix: `streamer1`, `s0001`, `v00001`. */
  handle: string;
  username: string;
  email: string;
  kind: SeedAccountKind;
  platformRole: string;
}

export interface SeededChannel {
  id: string;
  ownerId: string;
  ownerHandle: string;
  slug: string;
}

/**
 * What seed-social created, for every later unit. Units append only to their own entries (e.g.
 * seed-platform adds app ids) through `extra`; they never replace `users` or `channels`.
 */
export interface SeedStore {
  users: SeededUser[];
  channels: SeededChannel[];
  /** Per-unit findings later units may use (keyed by unit name, then free-form). */
  extra: Partial<Record<SeedUnitName, Record<string, unknown>>>;
}

export interface SeedContext {
  /** As the least-privilege app role (the database triggers apply, as for the services). */
  db: DbHandle;
  env: HarnessEnv;
  /** This unit's own stream (`root.fork(unit name)`). */
  rng: Rng;
  scale: SeedScale;
  scaleName: SeedScaleName;
  /** The shared password of every seeded login. */
  password: string;
  /** Wall-clock start of the run; backdated rows are relative to it. */
  now: Date;
  store: SeedStore;
  log: Logger;
  signal: AbortSignal;
}

export interface SeedUnitReport {
  /** Rows written per table (for the run summary). */
  rows: Record<string, number>;
  /** Anything a tester should know (e.g. a screen that can only show today's history). */
  notes?: string[];
}

export interface SeedUnit {
  name: SeedUnitName;
  /** Units that must finish first. */
  after: readonly SeedUnitName[];
  /** Tables this unit is responsible for filling (the coverage check partitions every table). */
  tables: readonly string[];
  /** Owned tables not seeded yet. Emptied unit by unit; the milestone requires it empty everywhere. */
  pending: readonly string[];
  run(ctx: SeedContext): Promise<SeedUnitReport>;
}

export const lookupUser = (store: SeedStore, handle: string): SeededUser => {
  const u = store.users.find((x) => x.handle === handle);
  if (!u) throw new Error(`seed: no user "${handle}" (seed-social runs first)`);
  return u;
};
