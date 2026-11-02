// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-coop's database reads, as the app role. Every co-op table is protected, so this unit never
 * writes through `ctx.db`: it reads the facts its plans need (birth dates, tier prices, the active
 * electorate), the rows it caused (for the privacy scan and the report), and the jury's sample (to
 * check that nothing excluded was drawn).
 */
import type { DbHandle } from "@commonair/db";
import type { AuditRow, EventRow, MemberClass } from "../../coop.ts";
import type { SampledCase, TierPrice } from "./plan.ts";

const CHUNK = 1_000;

/** Birth dates (ISO, or null) of the users `ids`, by id. */
export async function birthDates(h: DbHandle, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await h.sql<{ id: string; birth: string | null }[]>`
      select id::text as id, birth_date::text as birth from users where id = any(${chunk}::uuid[])`;
    for (const r of rows) out.set(r.id, r.birth);
  }
  return out;
}

/** Subscription tier prices by channel slug. */
export async function tierPrices(h: DbHandle): Promise<Record<string, TierPrice[]>> {
  const out: Record<string, TierPrice[]> = {};
  const rows = await h.sql<{ slug: string; tier: number; cents: string }[]>`
    select c.slug, t.tier::int as tier, t.price_cents::text as cents
      from channel_sub_tiers t join channels c on c.id = t.channel_id
     order by c.slug, t.tier`;
  for (const r of rows) {
    const tier = Number(r.tier);
    if (tier !== 1 && tier !== 2 && tier !== 3) continue;
    (out[r.slug] ??= []).push({ tier, price: { cents: Number(r.cents) } });
  }
  return out;
}

/** Active memberships: user id → classes (sorted). */
export async function activeClassesByUser(h: DbHandle): Promise<Map<string, MemberClass[]>> {
  const out = new Map<string, MemberClass[]>();
  const rows = await h.sql<{ user_id: string; class: MemberClass }[]>`
    select user_id::text as user_id, class::text as class from memberships where status = 'active'
     order by user_id, class`;
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.class]);
  return out;
}

/** Row counts of `tables` (names are this unit's own constant list, never input). */
export async function countRows(h: DbHandle, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) throw new Error(`seed-coop: bad table name ${t}`);
    const [r] = await h.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
    out[t] = Number(r?.n ?? 0);
  }
  return out;
}

/** Audit actions and event types the co-op writes (the privacy scan's scope). */
export const COOP_AUDIT_PREFIXES = [
  "proposal.",
  "council.",
  "election.",
  "membership.",
  "coop.",
  "patronage.",
  "jury.",
] as const;
export const COOP_EVENT_PREFIXES = ["coop.", "jury."] as const;

const likePatterns = (prefixes: readonly string[]) => prefixes.map((p) => `${p.replace(/[_%\\]/g, "\\$&")}%`);

/** The co-op audit and outbox rows written since `since` (this unit's own, on a fresh database). */
export async function coopRowsSince(h: DbHandle, since: Date): Promise<{ audit: AuditRow[]; events: EventRow[] }> {
  const audit = await h.sql<
    {
      action: string;
      actor_type: string;
      actor_id: string | null;
      subject_type: string;
      subject_id: string;
      details: unknown;
    }[]
  >`
    select action, actor_type::text as actor_type, actor_id::text as actor_id, subject_type, subject_id, details
      from audit_log
     where created_at >= ${since.toISOString()}::timestamptz and action like any(${likePatterns(COOP_AUDIT_PREFIXES)}::text[])`;
  const events = await h.sql<{ type: string; payload: unknown }[]>`
    select type, payload from events
     where occurred_at >= ${since.toISOString()}::timestamptz and type like any(${likePatterns(COOP_EVENT_PREFIXES)}::text[])`;
  return {
    audit: audit.map((r) => ({
      action: r.action,
      actorType: r.actor_type,
      actorId: r.actor_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      details: r.details,
    })),
    events: events.map((r) => ({ type: r.type, payload: r.payload })),
  };
}

/** The sampled cases of a jury panel, with their moderation tier and hash-list category. */
export async function sampledCases(h: DbHandle, panelId: string): Promise<SampledCase[]> {
  const rows = await h.sql<
    { subject_id: string; tier: string | null; list_category: string | null; rule_ref: string | null }[]
  >`
    select jc.subject_id::text as subject_id, mc.tier::text as tier, mc.list_category::text as list_category,
           coalesce(jc.rule_ref, mc.rule_ref) as rule_ref
      from jury_cases jc left join moderation_cases mc on mc.id = jc.subject_id
     where jc.panel_id = ${panelId}::uuid
     order by jc.subject_id`;
  return rows.map((r) => ({
    subjectId: r.subject_id,
    tier: r.tier,
    listCategory: r.list_category,
    ruleRef: r.rule_ref,
  }));
}
