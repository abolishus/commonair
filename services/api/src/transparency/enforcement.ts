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
 *
 * Windows overlap: `30d` covers the end of one calendar month and the start of the next, and both
 * months are published too. So windows end at a whole UTC day (the start of today), and a `30d`
 * figure is suppressed when any slice a reader could difference out of the published windows (the
 * `30d` part of each month, and the rest of that month) is under k. What stays possible is
 * differencing day by day (yesterday's report against today's), which ADR 0019 accepts.
 */
import type { EnforcementReport } from "@commonair/contracts/dto";
import {
  ENFORCEMENT_REPORT_RULES,
  type ENFORCEMENT_SOURCE_ACTIONS,
  type ModerationTier,
} from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { resolveCatalog } from "@commonair/email";
import { findClause, groupOfClauseId, parseRuleRef, REPORT_GROUP_IDS, type ReportGroup } from "@commonair/moderation";
import { and, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
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
  /**
   * Nothing to query: a month that has not started (or starts today), or one older than the
   * months the report offers (`ENFORCEMENT_REPORT_RULES.months`, the current one included).
   */
  empty: boolean;
  /**
   * Test hooks only: the rolling window ends now and is queried with no upper bound, so the harness
   * reads its own actions at once (and a row the database stamped a moment ahead of this process's
   * clock is not missed). Never on a public instance: an open window can be differenced by minute.
   */
  open: boolean;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * `30d` = `[today 00:00 UTC − 30 d, today 00:00 UTC)`; a month = `[first day 00:00 UTC, first day
 * of the next month)`, cut at today 00:00 UTC while it runs. With `live` (test hooks) `30d` is
 * `[now − 30 d, now)`, open-ended, and the current month runs to its end.
 */
export function windowBounds(window: EnforcementWindow, now: Date, opts: { live?: boolean } = {}): WindowBounds {
  const live = opts.live ?? false;
  const today = startOfUtcDay(now);
  if (window === "30d") {
    const end = live ? now : today;
    return {
      from: new Date(end.getTime() - ENFORCEMENT_REPORT_RULES.rollingDays * DAY_MS),
      to: end,
      empty: false,
      open: live,
    };
  }
  const m = MONTH.exec(window);
  if (!m) throw new Error(`not a report window: ${window}`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const from = new Date(Date.UTC(year, month, 1));
  // Date.UTC carries month 12 into January of the next year.
  const next = new Date(Date.UTC(year, month + 1, 1));
  // Years 0–99 would be read as 1900–1999 by Date.UTC.
  from.setUTCFullYear(year);
  next.setUTCFullYear(month === 11 ? year + 1 : year);
  const to = live || next.getTime() <= today.getTime() ? next : today;
  // The window picker offers the current month and the ones before it, `months` in all.
  const oldest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (ENFORCEMENT_REPORT_RULES.months - 1), 1);
  const t = from.getTime();
  return { from, to, empty: t >= to.getTime() || t > now.getTime() || t < oldest, open: false };
}

// ---------------------------------------------------------------- suppression

const visible = (value: number): ReportCount => ({ suppressed: false, value });
const SUPPRESSED: ReportCount = { suppressed: true };

/** A count as published: zero and anything from k up as a number, 1..k−1 suppressed. */
export function cell(n: number): ReportCount {
  return n === 0 || n >= K ? visible(n) : SUPPRESSED;
}

const isSmall = (n: number) => n > 0 && n < K;
type Flag = boolean | undefined;
/** Suppressed by the k rule, or forced by another window (`forcedBy`); zero is never hidden. */
const hidden = (n: number, forced: Flag) => n > 0 && (n < K || forced === true);

/**
 * A total over parts that partition it: suppressed (besides its own k rule) when exactly one part
 * is suppressed, since total − visible parts would give that part away. With two or more
 * suppressed parts only their sum shows.
 */
export function totalOver(total: number, parts: readonly number[], forced: readonly Flag[] = []): ReportCount {
  if (isSmall(total)) return SUPPRESSED;
  return parts.filter((n, i) => hidden(n, forced[i])).length === 1 ? SUPPRESSED : visible(total);
}

/**
 * Parts of a published total: each by the k rule, and when exactly one is suppressed, also the
 * smallest non-zero visible one, so the total minus the visible parts never isolates a suppressed
 * part. (Every other part zero cannot happen: the total would then be that part, under k.)
 */
export function partsOf(parts: readonly number[], forced: readonly Flag[] = []): ReportCount[] {
  const out = parts.map((n, i) => (hidden(n, forced[i]) ? SUPPRESSED : visible(n)));
  if (parts.filter((n, i) => hidden(n, forced[i])).length !== 1) return out;
  let pick = -1;
  for (const [i, n] of parts.entries())
    if (!hidden(n, forced[i]) && n > 0 && (pick < 0 || n < (parts[pick] ?? Number.POSITIVE_INFINITY))) pick = i;
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

const FIGURES = ["count", "fully", "partially", "not", "detected", "appealed", "overturned"] as const;
/** Figures another window forces hidden; `human` is `count − detected`. */
export type Forced = Partial<Record<(typeof FIGURES)[number] | "human", true>>;
const NCII_FIGURES = ["due", "onTime", "late", "pending"] as const;
export type NciiForced = Partial<Record<(typeof NCII_FIGURES)[number], true>>;

/** Zero, or hidden: with the row's count hidden, a non-zero part would show it. */
const zeroOrHidden = (n: number): ReportCount => (n === 0 ? visible(0) : SUPPRESSED);

/** A published row; `clauseTitle` is filled per request locale. */
export function publishCell(c: Cell, forced: Forced = {}): Omit<Row, "clauseTitle"> {
  const count = hidden(c.count, forced.count) ? SUPPRESSED : visible(c.count);
  const split = [c.fully, c.partially, c.not];
  const [fully, partially, not] = (
    count.suppressed ? split.map(zeroOrHidden) : partsOf(split, [forced.fully, forced.partially, forced.not])
  ) as [ReportCount, ReportCount, ReportCount];
  // `count − detected` is the human-detected cell: publishing `detected` beside the count shows it.
  const detected =
    count.suppressed || hidden(c.count - c.detected, forced.human) || forced.detected ? SUPPRESSED : cell(c.detected);
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
    appealed: count.suppressed || hidden(c.appealed, forced.appealed) ? SUPPRESSED : visible(c.appealed),
    overturned: count.suppressed || hidden(c.overturned, forced.overturned) ? SUPPRESSED : visible(c.overturned),
  };
}

/** The NCII line: `pending` (due − on time − late) is derivable, so it is a part of `due` too. */
export function publishNcii(n: NciiCounts, forced: NciiForced = {}): EnforcementReport["ncii"] {
  const pending = nciiPending(n);
  return {
    due: hidden(n.due, forced.due)
      ? SUPPRESSED
      : totalOver(n.due, [n.onTime, n.late, pending], [forced.onTime, forced.late, forced.pending]),
    onTime: hidden(n.onTime, forced.onTime) ? SUPPRESSED : visible(n.onTime),
    late: hidden(n.late, forced.late) ? SUPPRESSED : visible(n.late),
  };
}

const nciiPending = (n: NciiCounts) => Math.max(0, n.due - n.onTime - n.late);

/**
 * A slice of a window that a reader can difference out of the published windows: the part of the
 * `30d` window in one calendar month, or the rest of that month.
 */
export interface Piece {
  cells: readonly Cell[];
  ncii: NciiCounts;
}

/** Every figure some piece holds under k (zero excepted): those are hidden in the window. */
export function forcedBy(pieces: readonly Piece[]): {
  cells: Map<string, Forced>;
  total: boolean;
  ncii: NciiForced;
} {
  const cells = new Map<string, Forced>();
  let total = false;
  const ncii: NciiForced = {};
  for (const p of pieces) {
    const merged = mergeCells(p.cells);
    for (const c of merged) {
      const key = cellKey(c);
      const f = cells.get(key) ?? {};
      for (const k of FIGURES) if (isSmall(c[k])) f[k] = true;
      if (isSmall(c.count - c.detected)) f.human = true;
      cells.set(key, f);
    }
    if (isSmall(merged.reduce((s, c) => s + c.count, 0))) total = true;
    const n = { ...p.ncii, pending: nciiPending(p.ncii) };
    for (const k of NCII_FIGURES) if (isSmall(n[k])) ncii[k] = true;
  }
  return { cells, total, ncii };
}

export interface Assembled {
  window: EnforcementWindow;
  bounds: WindowBounds;
  rows: Omit<Row, "clauseTitle">[];
  total: ReportCount;
  ncii: EnforcementReport["ncii"];
}

/**
 * Pure: raw cells and NCII counts → the published figures, rows ordered by area, rule and tier.
 * `pieces` are the window's slices another published window exposes (`forcedBy`).
 */
export function assemble(
  window: EnforcementWindow,
  bounds: WindowBounds,
  cells: readonly Cell[],
  ncii: NciiCounts,
  pieces: readonly Piece[] = [],
): Assembled {
  const forced = forcedBy(pieces);
  const merged = mergeCells(cells).filter((c) => c.count > 0);
  const forcedOf = (c: Cell) => forced.cells.get(cellKey(c)) ?? {};
  const rows = merged
    .map((c) => publishCell(c, forcedOf(c)))
    .sort(
      (a, b) =>
        (GROUP_ORDER.get(a.group) ?? 99) - (GROUP_ORDER.get(b.group) ?? 99) ||
        a.clauseId.localeCompare(b.clauseId) ||
        a.clauseVersion - b.clauseVersion ||
        TIER_ORDER(a.tier) - TIER_ORDER(b.tier),
    );
  const counts = merged.map((c) => c.count);
  const sum = counts.reduce((s, n) => s + n, 0);
  const total = hidden(sum, forced.total)
    ? SUPPRESSED
    : totalOver(
        sum,
        counts,
        merged.map((c) => forcedOf(c).count),
      );
  return { window, bounds, rows, total, ncii: publishNcii(ncii, forced.ncii) };
}

// ---------------------------------------------------------------- queries

/** A query range: `to` null is open-ended; with `split`, rows are bucketed per piece (`bucketOf`). */
interface Range {
  from: Date;
  to: Date | null;
  split?: Date;
}

/**
 * `YYYY-MM:in` / `YYYY-MM:out`: the UTC month and which side of `split` (the `30d` start) a row
 * falls on. The instant is inlined (a server-made ISO string, never input) so the select and the
 * group by render the same expression.
 */
const bucketOf = (col: PgColumn, split: Date): SQL<string> =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM') || case when ${col} >= ${sql.raw(
    `'${split.toISOString()}'::timestamptz`,
  )} then ':in' else ':out' end`;

const inRange = (col: PgColumn, r: Range) => and(gte(col, r.from), r.to ? lt(col, r.to) : undefined);

const appealedSql = (subjectType: unknown, subjectId: unknown, overturned: boolean) =>
  sql<number>`count(*) filter (where exists (select 1 from ${appeals} a where a.subject_type = ${subjectType} and a.subject_id = ${subjectId}${
    overturned ? sql` and a.status = 'overturned'` : sql``
  }))::int`;

type Bucketed<T> = T & { bucket: string };

/** Statements in the range, per clause and source action (and bucket). */
async function statementCells(deps: Deps, r: Range): Promise<Bucketed<Cell>[]> {
  const bucket = r.split ? bucketOf(st.createdAt, r.split) : sql<string>`''`;
  const rows = await deps.db
    .select({
      clauseId: st.clauseId,
      clauseVersion: st.clauseVersion,
      sourceAction: st.sourceAction,
      bucket,
      count: sql<number>`count(*)::int`,
      fully: sql<number>`count(*) filter (where ${st.automatedDecision} = 'fully')::int`,
      partially: sql<number>`count(*) filter (where ${st.automatedDecision} = 'partially')::int`,
      not: sql<number>`count(*) filter (where ${st.automatedDecision} = 'not')::int`,
      detected: sql<number>`count(*) filter (where ${st.automatedDetection})::int`,
      appealed: appealedSql(st.appealSubjectType, st.appealSubjectId, false),
      overturned: appealedSql(st.appealSubjectType, st.appealSubjectId, true),
    })
    .from(st)
    .where(inRange(st.createdAt, r))
    .groupBy(st.clauseId, st.clauseVersion, st.sourceAction, ...(r.split ? [bucket] : []));
  return rows.map(({ sourceAction, ...row }) => ({ ...row, tier: tierOfSource(sourceAction) }));
}

/** Platform mod actions citing a clause that have no statement: decided by a person, after a report or not. */
async function modActionCells(deps: Deps, r: Range): Promise<Bucketed<Cell>[]> {
  const bucket = r.split ? bucketOf(modActions.createdAt, r.split) : sql<string>`''`;
  const rows = await deps.db
    .select({
      ruleRef: modActions.ruleRef,
      bucket,
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
        inRange(modActions.createdAt, r),
      ),
    )
    .groupBy(modActions.ruleRef, ...(r.split ? [bucket] : []));
  return rows.flatMap((row) => {
    const ref = row.ruleRef ? parseRuleRef(row.ruleRef) : null;
    if (!ref) return [];
    return [
      {
        bucket: row.bucket,
        clauseId: ref.id,
        clauseVersion: ref.version,
        tier: null,
        count: row.count,
        fully: 0,
        partially: 0,
        not: row.count,
        detected: 0,
        appealed: row.appealed,
        overturned: row.overturned,
      },
    ];
  });
}

/** NCII requests by deadline (and bucket); `late` counts undecided requests past their deadline at `now`. */
async function nciiCounts(deps: Deps, r: Range, now: Date): Promise<Bucketed<NciiCounts>[]> {
  const bucket = r.split ? bucketOf(nciiRequests.deadlineAt, r.split) : sql<string>`''`;
  const actedAt = sql`least(${nciiRequests.decidedAt}, ${nciiRequests.autoHiddenAt})`;
  const query = deps.db
    .select({
      bucket,
      due: sql<number>`count(*)::int`,
      onTime: sql<number>`count(*) filter (where ${actedAt} <= ${nciiRequests.deadlineAt})::int`,
      late: sql<number>`count(*) filter (where coalesce(${actedAt}, ${now.toISOString()}::timestamptz) > ${nciiRequests.deadlineAt})::int`,
    })
    .from(nciiRequests)
    .where(inRange(nciiRequests.deadlineAt, r));
  return r.split ? query.groupBy(bucket) : query;
}

const NO_NCII: NciiCounts = { due: 0, onTime: 0, late: 0 };
const sumNcii = (xs: readonly NciiCounts[]): NciiCounts =>
  xs.reduce((a, x) => ({ due: a.due + x.due, onTime: a.onTime + x.onTime, late: a.late + x.late }), NO_NCII);

/**
 * The raw figures for a window (three queries), or nothing for an empty one. The closed `30d`
 * window is read from the start of its first month, bucketed, so each piece another window
 * exposes is known (`forcedBy`).
 */
export async function loadReport(
  deps: Deps,
  window: EnforcementWindow,
  bounds: WindowBounds,
  now: Date,
): Promise<Assembled> {
  if (bounds.empty) return assemble(window, bounds, [], NO_NCII);
  const split = window === "30d" && !bounds.open;
  const range: Range = split
    ? { from: startOfUtcMonth(bounds.from), to: bounds.to, split: bounds.from }
    : { from: bounds.from, to: bounds.open ? null : bounds.to };
  const [statements, actions, ncii] = await Promise.all([
    statementCells(deps, range),
    modActionCells(deps, range),
    nciiCounts(deps, range, now),
  ]);
  const cells = [...statements, ...actions];
  if (!split) return assemble(window, bounds, cells, sumNcii(ncii));
  const buckets = new Set([...cells, ...ncii].map((x) => x.bucket));
  const pieces = [...buckets].map((b) => ({
    cells: cells.filter((c) => c.bucket === b),
    ncii: sumNcii(ncii.filter((n) => n.bucket === b)),
  }));
  const inside = (x: { bucket: string }) => x.bucket.endsWith(":in");
  return assemble(window, bounds, cells.filter(inside), sumNcii(ncii.filter(inside)), pieces);
}

// ---------------------------------------------------------------- titles, cache, entry point

/** The clause's plain-language title in `locale` (email catalog; English, then the id, as fallbacks). */
export function clauseTitleIn(locale: string, clauseId: string, clauseVersion: number): string {
  const key = findClause(clauseId, clauseVersion)?.titleKey ?? `clause.${clauseId}`;
  const titles = resolveCatalog(locale).catalog.enforcementStatement as Record<string, string>;
  return titles[key] ?? clauseId;
}

/** By window and bounds, least recently used first. */
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
  // The harness stack (test hooks on) reads its own actions back at once, uncached.
  const live = deps.env.MODERATION_TEST_HOOKS;
  const bounds = windowBounds(window, now, { live });
  const key = `${window}|${bounds.from.toISOString()}|${bounds.to.toISOString()}`;
  let entry = live ? undefined : cache.get(key);
  const age = entry ? now.getTime() - entry.at : Number.POSITIVE_INFINITY;
  if (!entry || age < 0 || age >= CACHE_MS)
    entry = { at: now.getTime(), report: await loadReport(deps, window, bounds, now) };
  cache.delete(key);
  if (!live) {
    for (const oldest of cache.keys()) {
      if (cache.size < CACHE_MAX) break;
      cache.delete(oldest);
    }
    cache.set(key, entry);
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
