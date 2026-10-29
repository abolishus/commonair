// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Small database helpers shared by the co-op handlers. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  PayoutRulesSetting,
  PlatformCutSetting,
  PointsAccrualSetting,
  type GovernanceChange,
} from "@commonair/contracts/shapes";
import { type Executor, schema } from "@commonair/db";
import {
  BoardSeats,
  CouncilConfig,
  MembershipClasses,
  OrdinaryRules,
  Protections,
  classifyChanges,
  type SettingsMap,
} from "@commonair/governance";
import { PatronageFormulaSetting } from "@commonair/patronage";
import { DiscoveryRanking } from "../lib/settings.ts";

const { users, memberships } = schema;

/** Staff (admins, treasurers) act as `admin` in the audit log, as in the treasury handlers. */
export const STAFF = "admin" as const;
export const MEMBER = "user" as const;

export const money = (cents: number, currency: string) => ({ cents, currency });

/** Whether the user holds any active membership (the comment trigger asks the same). */
export async function isActiveMember(db: Executor, userId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
    .limit(1);
  return m !== undefined;
}

export async function userPicks(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, { id: string; username: string; displayName: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/** A user who no longer resolves (never expected: users are pseudonymized, not deleted). */
export const unknownUser = (id: string) => ({ id, username: "deleted", displayName: "Deleted user" });

/**
 * The current creator council term: the latest by `computed_at` whose window contains the
 * database clock (the same rule as `commonair_current_council_term`).
 */
export async function currentCouncilTerm(db: Executor) {
  const [t] = await db
    .select()
    .from(schema.councilTerms)
    .where(
      sql`${schema.councilTerms.startsAt} <= clock_timestamp() and ${schema.councilTerms.endsAt} > clock_timestamp()`,
    )
    .orderBy(sql`${schema.councilTerms.computedAt} desc, ${schema.councilTerms.id} desc`)
    .limit(1);
  return t ?? null;
}

/** Shapes of the settings a proposal may change, where the platform reads a known shape. */
const VALUE_SHAPES: Readonly<Record<string, z.ZodType>> = {
  "governance.protections": Protections,
  "governance.ordinary": OrdinaryRules,
  "council.config": CouncilConfig,
  "membership.classes": MembershipClasses,
  "board.seats": BoardSeats,
  "patronage.formula": PatronageFormulaSetting,
  "platform.cut": PlatformCutSetting,
  "payout.rules": PayoutRulesSetting,
  "discovery.ranking": DiscoveryRanking,
  "interact.points.accrual": PointsAccrualSetting,
};

export type ClassifiedChanges =
  | { ok: true; kind: "ordinary" | "protected"; affectsCreators: boolean; keys: string[] }
  | { ok: false; reason: string };

/**
 * Classify a draft's changes the way the proposal trigger will: any protected key makes it
 * `protected` and forces `affectsCreators`. Ordinary proposals may have no changes. A value that
 * does not fit the setting's shape is refused now rather than failing when the decision applies.
 */
export function classifyDraft(
  changes: readonly GovernanceChange[],
  affectsCreators: boolean,
  settings: SettingsMap,
): ClassifiedChanges {
  if (changes.length === 0) return { ok: true, kind: "ordinary", affectsCreators, keys: [] };
  const c = classifyChanges(changes, settings);
  if (!c.ok) {
    const p = c.problems.find((x) => x.code !== "empty");
    if (p?.code === "unknown_key") return { ok: false, reason: `There is no setting named ${p.key}` };
    if (p?.code === "duplicate_key") return { ok: false, reason: `${p.key} is changed more than once` };
    return { ok: false, reason: "The changes are invalid" };
  }
  for (const ch of changes) {
    const shape = VALUE_SHAPES[ch.key];
    if (shape && !shape.safeParse(ch.value).success)
      return { ok: false, reason: `The new value of ${ch.key} does not have the setting's shape` };
  }
  return {
    ok: true,
    kind: c.kind,
    affectsCreators: affectsCreators || c.affectsCreatorsRequired,
    keys: changes.map((x) => x.key),
  };
}
