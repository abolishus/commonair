// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The open enforcement report (W2-enforcement-report, ADR 0019, batch 6 decision (d)): per rule
 * (`<clause id>@<version>`) and tier, how many platform actions there were, how many were decided
 * by a model and how many by a person, how many were appealed and overturned, and whether NCII
 * requests were acted on within their 48 hours.
 *
 * Unit of count: one statement of reasons (`enforcement_statements`, by `created_at`), plus the
 * platform `mod_actions` that cite a clause and have no statement (report resolutions and admin
 * suspensions). A moderator's case decision (`subject_type = 'moderation_case'`) has its statement
 * and is never counted twice; channel-scope actions carry no `rule_ref` and never appear; a
 * CSAM-list match has no statement and no `rule_ref` (ADR 0019 decision 1).
 *
 * Privacy: any count under `ENFORCEMENT_REPORT_RULES.k` (zero excepted) is `{suppressed: true}`,
 * and a figure that, with the visible cells beside it, would give a suppressed cell away is
 * suppressed too (complementary suppression). Ratios go out as integer numerator and denominator.
 */
import type { EnforcementReport } from "@commonair/contracts/dto";
import {
  ENFORCEMENT_REPORT_RULES,
  type ENFORCEMENT_SOURCE_ACTIONS,
  type ModerationTier,
} from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { resolveCatalog } from "@commonair/email";
import { findClause } from "@commonair/moderation";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
// The report grouping lives with the catalog (`@commonair/moderation`'s `clauses.ts`); the package
// index does not export it yet (contract request), so it is imported by path.
import {
  groupOfClauseId,
  parseRuleRef,
  REPORT_GROUP_IDS,
  type ReportGroup,
} from "../../../../packages/moderation/src/clauses.ts";
import type { Deps } from "../deps.ts";

const { enforcementStatements: st, modActions, appeals, nciiRequests } = schema;
const K = ENFORCEMENT_REPORT_RULES.k;
const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;
const CACHE_MAX = 64;

/** `30d` (rolling) or a calendar month `YYYY-MM` (UTC), as `transparency.enforcement` validates it. */
export type EnforcementWindow = string;
type ReportCount = EnforcementReport["total"];
type Row = EnforcementReport["rows"][number];
type SourceAction = (typeof ENFORCEMENT_SOURCE_ACTIONS)[number];

// ---------------------------------------------------------------- window

export interface WindowBounds {
  from: Date;
  to: Date;
  /** A month that has not started: nothing to query. */
  future: boolean;
  /**
   * The rolling window ends now: actions are counted with no upper bound, so a row the database
   * stamped a moment ahead of this process's clock is not missed.
   */
  rolling: boolean;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `[now − 30 d, now)`, or `[first day 00:00 UTC, first day of the next month)`. */
export function windowBounds(window: EnforcementWindow, now: Date): WindowBounds {
  if (window === "30d")
    return {
      from: new Date(now.getTime() - ENFORCEMENT_REPORT_RULES.rollingDays * DAY_MS),
      to: now,
      future: false,
      rolling: true,
    };
  const m = MONTH.exec(window);
  if (!m) throw new Error(`not a report window: ${window}`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const from = new Date(Date.UTC(year, month, 1));
  // Date.UTC carries month 12 into January of the next year.
  const to = new Date(Date.UTC(year, month + 1, 1));
  // Years 0–99 would be read as 1900–1999 by Date.UTC.
  from.setUTCFullYear(year);
  to.setUTCFullYear(month === 11 ? year + 1 : year);
  return { from, to, future: from.getTime() > now.getTime(), rolling: false };
}

// ---------------------------------------------------------------- suppression

const visible = (value: number): ReportCount => ({ suppressed: false, value });
const SUPPRESSED: ReportCount = { suppressed: true };

/** A count as published: zero and anything from k up as a number, 1..k−1 suppressed. */
export function cell(n: number): ReportCount {
  return n === 0 || n >= K ? visible(n) : SUPPRESSED;
}

const isSmall = (n: number) => n > 0 && n < K;

/**
 * A total over parts that partition it: suppressed (besides its own k rule) when exactly one part
 * is suppressed, since total − visible parts would give that part away. With two or more
 * suppressed parts only their sum shows.
 */
export function totalOver(total: number, parts: readonly number[]): ReportCount {
  if (isSmall(total)) return SUPPRESSED;
  return parts.filter(isSmall).length === 1 ? SUPPRESSED : visible(total);
}

/**
 * Parts of a published total: each by the k rule, and when exactly one is suppressed, also the
 * smallest non-zero visible one, so the total minus the visible parts never isolates a suppressed
 * part. (Every other part zero cannot happen: the total would then be that part, under k.)
 */
export function partsOf(parts: readonly number[]): ReportCount[] {
  const out = parts.map(cell);
  if (parts.filter(isSmall).length !== 1) return out;
  let pick = -1;
  for (const [i, n] of parts.entries())
    if (!isSmall(n) && n > 0 && (pick < 0 || n < (parts[pick] ?? Number.POSITIVE_INFINITY))) pick = i;
  if (pick >= 0) out[pick] = SUPPRESSED;
  return out;
}

// ---------------------------------------------------------------- cells

/** One rule and tier, raw. */
export interface Cell {
  clauseId: string;
  clauseVersion: number;
  tier: ModerationTier | null;
  count: number;
  fully: number;
  partially: number;
  not: number;
  /** Detected by a model (the rest by a person: a report, a request, a moderator). */
  detected: number;
  appealed: number;
  overturned: number;
}

export interface NciiCounts {
  /** Requests whose 48 h deadline falls in the window. */
  due: number;
  /** Decided or auto-hidden by the deadline. */
  onTime: number;
  /** Acted on after the deadline, or past it and still undecided. */
  late: number;
}

/** The tier a statement's source action belongs to; NCII requests are not a tier. */
const TIER_OF: Readonly<Record<SourceAction, ModerationTier | null>> = {
  "moderation.t1.restrict": "t1",
  "moderation.t1.upload_reject": "t1",
  "moderation.t2.label": "t2",
  // Case decisions are made in the T1 queue.
  "moderation.case.warn": "t1",
  "moderation.case.end_stream": "t1",
  "moderation.case.suspend": "t1",
  "moderation.t0.match": "t0",
  "ncii.decide": null,
  "ncii.auto_hide": null,
};

export const tierOfSource = (action: string): ModerationTier | null =>
  Object.hasOwn(TIER_OF, action) ? (TIER_OF[action as SourceAction] ?? null) : null;

const cellKey = (c: Pick<Cell, "clauseId" | "clauseVersion" | "tier">) =>
  `${c.clauseId}@${c.clauseVersion}|${c.tier ?? ""}`;

/** Adds cells with the same rule and tier together. */
export function mergeCells(cells: readonly Cell[]): Cell[] {
  const out = new Map<string, Cell>();
  for (const c of cells) {
    const key = cellKey(c);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...c });
      continue;
    }
    prev.count += c.count;
    prev.fully += c.fully;
    prev.partially += c.partially;
    prev.not += c.not;
    prev.detected += c.detected;
    prev.appealed += c.appealed;
    prev.overturned += c.overturned;
  }
  return [...out.values()];
}

const GROUP_ORDER = new Map<ReportGroup, number>(REPORT_GROUP_IDS.map((g, i) => [g, i]));
const TIER_ORDER = (t: ModerationTier | null) => (t === null ? 9 : Number(t.slice(1)));

/** A published row; `clauseTitle` is filled per request locale. */
export function publishCell(c: Cell): Omit<Row, "clauseTitle"> {
  const count = cell(c.count);
  const [fully, partially, not] = count.suppressed
    ? [cell(c.fully), cell(c.partially), cell(c.not)]
    : (partsOf([c.fully, c.partially, c.not]) as [ReportCount, ReportCount, ReportCount]);
  // `count − detected` is the human-detected cell: publishing `detected` beside the count shows it.
  const detected = count.suppressed || isSmall(c.count - c.detected) ? SUPPRESSED : cell(c.detected);
  return {
    ruleRef: `${c.clauseId}@${c.clauseVersion}`,
    clauseId: c.clauseId,
    clauseVersion: c.clauseVersion,
    group: groupOfClauseId(c.clauseId) ?? "general",
    tier: c.tier,
    count,
    automatedDecision: { fully, partially, not },
    automatedDetection: detected,
    // The overturn rate's denominator is the count: with it suppressed, so is the rate.
    appealed: count.suppressed ? SUPPRESSED : cell(c.appealed),
    overturned: count.suppressed ? SUPPRESSED : cell(c.overturned),
  };
}

/** The NCII line: `pending` (due − on time − late) is derivable, so it is a part of `due` too. */
export function publishNcii(n: NciiCounts): EnforcementReport["ncii"] {
  const pending = Math.max(0, n.due - n.onTime - n.late);
  return { due: totalOver(n.due, [n.onTime, n.late, pending]), onTime: cell(n.onTime), late: cell(n.late) };
}

export interface Assembled {
  window: EnforcementWindow;
  bounds: WindowBounds;
  rows: Omit<Row, "clauseTitle">[];
  total: ReportCount;
  ncii: EnforcementReport["ncii"];
}

/** Pure: raw cells and NCII counts → the published figures, rows ordered by area, rule and tier. */
export function assemble(
  window: EnforcementWindow,
  bounds: WindowBounds,
  cells: readonly Cell[],
  ncii: NciiCounts,
): Assembled {
  const merged = mergeCells(cells).filter((c) => c.count > 0);
  const rows = merged
    .map(publishCell)
    .sort(
      (a, b) =>
        (GROUP_ORDER.get(a.group) ?? 99) - (GROUP_ORDER.get(b.group) ?? 99) ||
        a.clauseId.localeCompare(b.clauseId) ||
        a.clauseVersion - b.clauseVersion ||
        TIER_ORDER(a.tier) - TIER_ORDER(b.tier),
    );
  const counts = merged.map((c) => c.count);
  const total = totalOver(
    counts.reduce((s, n) => s + n, 0),
    counts,
  );
  return { window, bounds, rows, total, ncii: publishNcii(ncii) };
}

// ---------------------------------------------------------------- queries

const appealedSql = (subjectType: unknown, subjectId: unknown, overturned: boolean) =>
  sql<number>`count(*) filter (where exists (select 1 from ${appeals} a where a.subject_type = ${subjectType} and a.subject_id = ${subjectId}${
    overturned ? sql` and a.status = 'overturned'` : sql``
  }))::int`;

/** Statements in the window, per clause and source action. */
async function statementCells(deps: Deps, b: WindowBounds): Promise<Cell[]> {
  const rows = await deps.db
    .select({
      clauseId: st.clauseId,
      clauseVersion: st.clauseVersion,
      sourceAction: st.sourceAction,
      count: sql<number>`count(*)::int`,
      fully: sql<number>`count(*) filter (where ${st.automatedDecision} = 'fully')::int`,
      partially: sql<number>`count(*) filter (where ${st.automatedDecision} = 'partially')::int`,
      not: sql<number>`count(*) filter (where ${st.automatedDecision} = 'not')::int`,
      detected: sql<number>`count(*) filter (where ${st.automatedDetection})::int`,
      appealed: appealedSql(st.appealSubjectType, st.appealSubjectId, false),
      overturned: appealedSql(st.appealSubjectType, st.appealSubjectId, true),
    })
    .from(st)
    .where(and(gte(st.createdAt, b.from), b.rolling ? undefined : lt(st.createdAt, b.to)))
    .groupBy(st.clauseId, st.clauseVersion, st.sourceAction);
  return rows.map(({ sourceAction, ...r }) => ({ ...r, tier: tierOfSource(sourceAction) }));
}

/** Platform mod actions citing a clause that have no statement: decided by a person, after a report or not. */
async function modActionCells(deps: Deps, b: WindowBounds): Promise<Cell[]> {
  const rows = await deps.db
    .select({
      ruleRef: modActions.ruleRef,
      count: sql<number>`count(*)::int`,
      appealed: appealedSql(sql`'moderation_action'`, modActions.id, false),
      overturned: appealedSql(sql`'moderation_action'`, modActions.id, true),
    })
    .from(modActions)
    .where(
      and(
        eq(modActions.scope, "platform"),
        isNotNull(modActions.ruleRef),
        sql`${modActions.subjectType} is distinct from 'moderation_case'`,
        gte(modActions.createdAt, b.from),
        b.rolling ? undefined : lt(modActions.createdAt, b.to),
      ),
    )
    .groupBy(modActions.ruleRef);
  return rows.flatMap((r) => {
    const ref = r.ruleRef ? parseRuleRef(r.ruleRef) : null;
    if (!ref) return [];
    return [
      {
        clauseId: ref.id,
        clauseVersion: ref.version,
        tier: null,
        count: r.count,
        fully: 0,
        partially: 0,
        not: r.count,
        detected: 0,
        appealed: r.appealed,
        overturned: r.overturned,
      },
    ];
  });
}

async function nciiCounts(deps: Deps, b: WindowBounds, now: Date): Promise<NciiCounts> {
  const actedAt = sql`least(${nciiRequests.decidedAt}, ${nciiRequests.autoHiddenAt})`;
  const [r] = await deps.db
    .select({
      due: sql<number>`count(*)::int`,
      onTime: sql<number>`count(*) filter (where ${actedAt} <= ${nciiRequests.deadlineAt})::int`,
      late: sql<number>`count(*) filter (where coalesce(${actedAt}, ${now.toISOString()}::timestamptz) > ${nciiRequests.deadlineAt})::int`,
    })
    .from(nciiRequests)
    .where(and(gte(nciiRequests.deadlineAt, b.from), lt(nciiRequests.deadlineAt, b.to)));
  return { due: r?.due ?? 0, onTime: r?.onTime ?? 0, late: r?.late ?? 0 };
}

/** The raw figures for a window (three queries), or nothing for a month that has not started. */
export async function loadReport(deps: Deps, window: EnforcementWindow, now: Date): Promise<Assembled> {
  const bounds = windowBounds(window, now);
  if (bounds.future) return assemble(window, bounds, [], { due: 0, onTime: 0, late: 0 });
  const [statements, actions, ncii] = await Promise.all([
    statementCells(deps, bounds),
    modActionCells(deps, bounds),
    nciiCounts(deps, bounds, now),
  ]);
  return assemble(window, bounds, [...statements, ...actions], ncii);
}

// ---------------------------------------------------------------- titles, cache, entry point

/** The clause's plain-language title in `locale` (email catalog; English, then the id, as fallbacks). */
export function clauseTitleIn(locale: string, clauseId: string, clauseVersion: number): string {
  const key = findClause(clauseId, clauseVersion)?.titleKey ?? `clause.${clauseId}`;
  const titles = resolveCatalog(locale).catalog.enforcementStatement as Record<string, string>;
  return titles[key] ?? clauseId;
}

const cache = new Map<string, { at: number; report: Assembled }>();

/** Drop the in-process cache (tests). */
export function clearEnforcementCache(): void {
  cache.clear();
}

export async function enforcementReport(
  deps: Deps,
  window: EnforcementWindow,
  opts: { locale?: string } = {},
): Promise<EnforcementReport> {
  const now = deps.now();
  // The harness stack (test hooks on) reads its own actions back at once.
  let entry = deps.env.MODERATION_TEST_HOOKS ? undefined : cache.get(window);
  const age = entry ? now.getTime() - entry.at : Number.POSITIVE_INFINITY;
  if (!entry || age < 0 || age >= CACHE_MS) {
    entry = { at: now.getTime(), report: await loadReport(deps, window, now) };
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(window, entry);
  }
  const { report } = entry;
  const locale = opts.locale ?? "en";
  return {
    window: report.window,
    from: report.bounds.from.toISOString(),
    to: report.bounds.to.toISOString(),
    rows: report.rows.map((r) => ({ ...r, clauseTitle: clauseTitleIn(locale, r.clauseId, r.clauseVersion) })),
    total: report.total,
    ncii: report.ncii,
    generatedAt: new Date(entry.at).toISOString(),
  };
}
