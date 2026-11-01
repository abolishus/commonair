// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` W2 extension `enforcement` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0019,
 * batch 6 decision (d)): the open enforcement report moves with the scenario's own actions.
 *
 * Counts are instance-wide and a fresh stack starts below k = 10, where every cell is suppressed.
 * So `before` tops the two cells steps 4 and 5 act on (T2 `mature.unlabelled@1`, T1
 * `safety.sexual-explicit@1`) up to k − 1 with statement rows written through `DATABASE_URL`
 * (audit action `harness.enforcement.seed`, which the statement builder and coverage sweep never
 * select; recipients are fresh ids nobody signs in as), and the T2 cell's overturned appeals too.
 * The real actions then cross k: `after` waits for the worker's statements and asserts the counts,
 * the automated split and the overturn rate moved, that a below-k cell is suppressed, that a
 * channel ban moves nothing, and (web) that `/transparency` shows the report with a suppressed cell.
 */
import { ENFORCEMENT_REPORT_RULES } from "@commonair/contracts/enums";
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import type { ApiClient } from "../api/client.ts";
import { type Run, UI_TIMEOUT_MS } from "../safety-run.ts";
import { waitFor } from "../wait.ts";
import { tsParam } from "./sql-time.ts";
import { ROUTES } from "../web/selectors.ts";
import type { SafetyW2Extension } from "./kit.ts";

const K = ENFORCEMENT_REPORT_RULES.k;
const DAY_MS = 86_400_000;
/** The worker builds statements on a schedule; give it room on a loaded runner. */
const STATEMENT_TIMEOUT_MS = 180_000;
const SEED_ACTION = "harness.enforcement.seed";

/** Report test ids (docs/testing/w2-selectors.md "Enforcement report"). */
export const ENFORCEMENT_IDS = {
  report: "enforcement-report",
  row: "enforcement-report-row",
  suppressed: "enforcement-report-suppressed",
  ncii: "enforcement-report-ncii",
} as const;

type Report = Awaited<ReturnType<ApiClient["transparency"]["enforcement"]>>;
type Row = Report["rows"][number];
type Count = Report["total"];
type Tier = Row["tier"];

/** One report cell the extension follows: a clause at version 1 and a tier; `sourceAction` is what it seeds. */
export interface CellSpec {
  clauseId: string;
  sourceAction: string;
  tier: Exclude<Tier, null>;
}

/** The statement source actions the report puts in each tier (`services/api/src/transparency/enforcement.ts`). */
export const TIER_SOURCES: Readonly<Record<CellSpec["tier"], readonly string[]>> = {
  t0: ["moderation.t0.match"],
  t1: [
    "moderation.t1.restrict",
    "moderation.t1.upload_reject",
    "moderation.case.warn",
    "moderation.case.end_stream",
    "moderation.case.suspend",
  ],
  t2: ["moderation.t2.label"],
};

/** Step 4 labels C mature (T2); step 5 restricts D's stream for `sexual` (T1). */
export const T2_CELL: CellSpec = { clauseId: "mature.unlabelled", sourceAction: "moderation.t2.label", tier: "t2" };
export const T1_CELL: CellSpec = {
  clauseId: "safety.sexual-explicit",
  sourceAction: "moderation.t1.restrict",
  tier: "t1",
};
/**
 * Cells nothing in the scenario writes, tried in order for the below-k check: the first whose
 * count is under k − 1 gets one more row, so it sits in 1..k−1 and must be suppressed.
 */
export const SMALL_CANDIDATES: readonly CellSpec[] = [
  { clauseId: "honesty.impersonation", sourceAction: "moderation.case.warn", tier: "t1" },
  { clauseId: "creative.copyright", sourceAction: "moderation.case.end_stream", tier: "t1" },
  { clauseId: "decency.hate", sourceAction: "moderation.case.end_stream", tier: "t1" },
  { clauseId: "safety.weapons", sourceAction: "moderation.case.end_stream", tier: "t1" },
];

export const refOf = (c: CellSpec) => `${c.clauseId}@1`;
export const value = (c: Count | undefined): number | null => (c && !c.suppressed ? c.value : null);
export const rowOf = (r: Report, c: CellSpec): Row | undefined =>
  r.rows.find((x) => x.ruleRef === refOf(c) && x.tier === c.tier);

/**
 * The raw figures of one cell (clause and tier, every source action of the tier) since `since`:
 * the report's own definition, minus rows old enough to leave the window while the scenario runs.
 */
export interface RawCell {
  count: number;
  fully: number;
  overturned: number;
}

/**
 * How many rows to seed so the cell sits at k − 1 actions and k − 1 overturned (when `overturned`
 * is asked for); the extra overturned rows are part of the seeded actions.
 */
export function topUpPlan(raw: RawCell, opts: { overturned: boolean }): { seed: number; overturned: number } {
  const overturned = opts.overturned ? Math.max(0, K - 1 - raw.overturned) : 0;
  return { seed: Math.max(K - 1 - raw.count, overturned), overturned };
}

/** The first candidate the extension can push into 1..k−1 with one row, or null. */
export function pickSmall(counts: readonly number[]): number | null {
  const i = counts.findIndex((n) => n + 1 <= K - 1);
  return i < 0 ? null : i;
}

export async function rawCell(h: DbHandle, c: CellSpec, since: Date): Promise<RawCell> {
  const [r] = await h.sql<RawCell[]>`
    select count(*)::int as count,
           count(*) filter (where s.automated_decision = 'fully')::int as fully,
           count(*) filter (where exists (
             select 1 from appeals a
             where a.subject_type = s.appeal_subject_type and a.subject_id = s.appeal_subject_id
               and a.status = 'overturned'))::int as overturned
    from enforcement_statements s
    where s.clause_id = ${c.clauseId} and s.clause_version = 1
      and s.source_action in ${h.sql([...TIER_SOURCES[c.tier]])}
      and s.created_at >= ${tsParam(since)}::timestamptz`;
  return { count: r?.count ?? 0, fully: r?.fully ?? 0, overturned: r?.overturned ?? 0 };
}

async function documentIds(h: DbHandle): Promise<{ guidelines: string; notice: string }> {
  const latest = async (kind: "guidelines" | "enforcement_notice") => {
    const [d] = await h.sql<{ id: string }[]>`
      select id from legal_documents where kind = ${kind} order by published_at desc limit 1`;
    if (!d) throw new Error(`no ${kind} document on this stack`);
    return d.id;
  };
  return { guidelines: await latest("guidelines"), notice: await latest("enforcement_notice") };
}

/**
 * `n` statements of a cell, fully automated (as the real T1/T2 actions are), an hour old. The first
 * `overturned` get an overturned appeal from `appellantId` on a fresh content-label subject.
 */
async function seedCell(
  h: DbHandle,
  c: CellSpec,
  n: number,
  opts: { overturned: number; appellantId: string; resolverId: string },
): Promise<void> {
  if (n <= 0) return;
  const docs = await documentIds(h);
  const at = new Date(Date.now() - 3_600_000);
  await h.db.transaction(async (tx) => {
    for (let i = 0; i < n; i++) {
      const auditId = uuidv7(at.getTime());
      await tx.insert(schema.auditLog).values({
        id: auditId,
        actorType: "system",
        action: SEED_ACTION,
        subjectType: "harness",
        subjectId: auditId,
        details: { clauseId: c.clauseId, sourceAction: c.sourceAction },
        createdAt: at,
      });
      const subjectId = uuidv7(at.getTime());
      await tx.insert(schema.enforcementStatements).values({
        id: uuidv7(at.getTime()),
        sourceAuditId: auditId,
        sourceAction: c.sourceAction,
        recipientUserId: uuidv7(at.getTime()),
        contentType: "broadcast",
        contentId: uuidv7(at.getTime()),
        restrictionKind: "visibility",
        restrictionDetail: c.tier === "t2" ? "age_gated" : "restricted",
        facts: {
          code: "classifier",
          category: "sexual",
          tier: c.tier === "t2" ? "t2" : "t1",
          threshold: 0.9,
          capturedAt: at.toISOString(),
        },
        source: "own_initiative",
        automatedDetection: true,
        automatedDecision: "fully",
        groundKind: "terms",
        clauseId: c.clauseId,
        clauseVersion: 1,
        guidelinesDocumentId: docs.guidelines,
        noticeDocumentId: docs.notice,
        appealSubjectType: "content_label",
        appealSubjectId: subjectId,
        createdAt: at,
      });
      if (i < opts.overturned)
        await tx.insert(schema.appeals).values({
          appellantId: opts.appellantId,
          kind: "moderation",
          subjectType: "content_label",
          subjectId,
          body: "harness enforcement report seed",
          status: "overturned",
          resolverId: opts.resolverId,
          resolution: "harness enforcement report seed",
          resolvedAt: at,
          createdAt: at,
        });
    }
  });
}

export interface EnforcementBefore {
  /** The cells' raw figures once topped up (what the report must exceed afterwards). */
  t2: RawCell;
  t1: RawCell;
  /** The below-k cell, or null when every candidate was already at k − 1 or more. */
  small: CellSpec | null;
}

const figures = (r: Report) => ({ rows: r.rows, total: r.total, ncii: r.ncii });
const read = (run: Run): Promise<Report> => run.anon().transparency.enforcement({ window: "30d" });

export const enforcementExtension: SafetyW2Extension<EnforcementBefore> = {
  async before(run) {
    const { ctx } = run;
    const first = await read(run);
    ctx.assert("enforcement: the report answers signed out (30d)", first.window === "30d", { window: first.window });
    const db = createDb({ url: run.databaseUrl, max: 1, applicationName: "commonair-harness-w2-enforcement" });
    try {
      // Rows that could age out of the window during the run are left out of the baseline.
      const since = new Date(Date.now() - 30 * DAY_MS + 2 * 3_600_000);
      const seeded = { appellantId: run.staff.admin.id, resolverId: run.staff.mod.id };
      const t2Raw = await rawCell(db, T2_CELL, since);
      const t2Plan = topUpPlan(t2Raw, { overturned: true });
      await seedCell(db, T2_CELL, t2Plan.seed, { ...seeded, overturned: t2Plan.overturned });
      const t1Raw = await rawCell(db, T1_CELL, since);
      const t1Plan = topUpPlan(t1Raw, { overturned: false });
      await seedCell(db, T1_CELL, t1Plan.seed, { ...seeded, overturned: 0 });
      const smallCounts = await Promise.all(SMALL_CANDIDATES.map(async (c) => (await rawCell(db, c, since)).count));
      const pick = pickSmall(smallCounts);
      const small = pick === null ? null : (SMALL_CANDIDATES[pick] ?? null);
      if (small) await seedCell(db, small, 1, { ...seeded, overturned: 0 });
      const before: EnforcementBefore = {
        t2: await rawCell(db, T2_CELL, since),
        t1: await rawCell(db, T1_CELL, since),
        small,
      };
      ctx.data("w2.enforcement.before", { ...before, seeded: { t2: t2Plan, t1: t1Plan } });
      return before;
    } finally {
      await db.close();
    }
  },

  async after(run, before) {
    const { ctx } = run;
    // The T2 label (step 4) and T1 restriction (step 5) each produce one statement; the label's
    // appeal was overturned in step 4.
    const moved = await ctx.step("enforcement: the T1 and T2 cells cross k and the T2 overturn moves", () =>
      waitFor(
        "the report counts the scenario's T1 and T2 actions",
        async () => {
          const r = await read(run);
          const t2 = rowOf(r, T2_CELL);
          const t1 = rowOf(r, T1_CELL);
          const ok =
            (value(t2?.count) ?? 0) >= before.t2.count + 1 &&
            (value(t2?.overturned) ?? 0) >= before.t2.overturned + 1 &&
            (value(t1?.count) ?? 0) >= before.t1.count + 1;
          return ok ? { r, t2: t2 as Row, t1: t1 as Row } : null;
        },
        { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
      ),
    );
    ctx.assert("enforcement: the T2 cell is published at k or more", (value(moved.t2.count) ?? 0) >= K, moved.t2);
    ctx.assert(
      "enforcement: the T2 automated split moved (fully automated)",
      (value(moved.t2.automatedDecision.fully) ?? 0) >= before.t2.fully + 1,
      { before: before.t2, after: moved.t2.automatedDecision },
    );
    ctx.assert(
      "enforcement: the T1 automated split moved (fully automated)",
      (value(moved.t1.automatedDecision.fully) ?? 0) >= before.t1.fully + 1,
      { before: before.t1, after: moved.t1.automatedDecision },
    );
    ctx.assert(
      "enforcement: the overturned T2 appeal moved the overturn rate's numerator; the denominator is the count",
      (value(moved.t2.overturned) ?? 0) >= before.t2.overturned + 1 && moved.t2.count.suppressed === false,
      { overturned: moved.t2.overturned, count: moved.t2.count },
    );
    ctx.assert("enforcement: rows carry clause titles", moved.t2.clauseTitle.length > 0 && moved.t2.group === "mature");

    if (before.small) {
      const small = rowOf(moved.r, before.small);
      ctx.assert("enforcement: a below-k cell is suppressed", small?.count.suppressed === true, {
        ruleRef: refOf(before.small),
        row: small ?? null,
      });
    } else ctx.check("enforcement: a below-k candidate cell was available", false);

    // A channel ban carries no clause: once the report is steady, it moves nothing.
    const owner = await ctx.step("enforcement: sign up a channel owner and a chatter", () =>
      run.ctx.platform.signUp({ prefix: "ts_enf_owner" }),
    );
    const chatter = await run.ctx.platform.signUp({ prefix: "ts_enf_chat" });
    run.emails.push(owner.email, chatter.email);
    const channel = owner.me.channelSlug ?? owner.username;
    const steady = await ctx.step("enforcement: the report is steady", () =>
      waitFor(
        "two equal reads",
        async () => {
          const a = await read(run);
          await Bun.sleep(3_000);
          const b = await read(run);
          return JSON.stringify(figures(a)) === JSON.stringify(figures(b)) ? b : null;
        },
        { timeoutMs: STATEMENT_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
      ),
    );
    await ctx.step("enforcement: the owner bans the chatter from the channel", () =>
      owner.api.client.chat.bans.ban({ channel, username: chatter.username, reason: "harness" }),
    );
    const afterBan = await read(run);
    ctx.assert(
      "enforcement: a channel ban leaves every count unchanged",
      JSON.stringify(figures(afterBan)) === JSON.stringify(figures(steady)),
      { before: figures(steady).total, after: figures(afterBan).total },
    );
    const db = createDb({ url: run.databaseUrl, max: 1, applicationName: "commonair-harness-w2-enforcement" });
    try {
      const [ban] = await db.sql<{ scope: string; ruleRef: string | null }[]>`
        select scope, rule_ref as "ruleRef" from mod_actions where target_user_id = ${chatter.id} and action = 'ban'`;
      ctx.assert(
        "enforcement: the ban is a channel-scope action citing no rule",
        ban?.scope === "channel" && ban.ruleRef === null,
        ban,
      );
    } finally {
      await db.close();
    }

    if (run.via === "web") {
      const viewer = await run.webSession("enforcement-report");
      await ctx.step("web: /transparency shows the enforcement report with a suppressed cell", async () => {
        const page = await viewer.goto(ROUTES.transparency);
        await page.locator(`[data-testid="${ENFORCEMENT_IDS.report}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
        const t2 = page.locator(
          `[data-testid="${ENFORCEMENT_IDS.row}"][data-rule-ref="${refOf(T2_CELL)}"][data-tier="${T2_CELL.tier}"]`,
        );
        await t2.waitFor({ timeout: UI_TIMEOUT_MS });
        const count = Number(await t2.getAttribute("data-count"));
        ctx.assert("web: the T2 row shows its count", count >= K, { count });
        await page.locator(`[data-testid="${ENFORCEMENT_IDS.suppressed}"]`).first().waitFor({ timeout: UI_TIMEOUT_MS });
        if (before.small) {
          const small = page.locator(
            `[data-testid="${ENFORCEMENT_IDS.row}"][data-rule-ref="${refOf(before.small)}"][data-tier="${before.small.tier}"]`,
          );
          ctx.assert(
            "web: the below-k row is marked suppressed",
            (await small.getAttribute("data-suppressed")) === "true",
          );
        }
        await page.locator(`[data-testid="${ENFORCEMENT_IDS.ncii}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
      });
    }
  },
};

/**
 * `trust-safety` W3 extension `sor-resolve` (batch 7; `src/w3/steps.ts`): a report resolved with a
 * suspension has a statement of reasons. Runs around the scenario's steps, as `enforcement`. Stub
 * entry point from the batch 7 contract step: B7-followups fills it.
 */
export const sorResolveExtension: SafetyW2Extension = {
  async before(_run: Run): Promise<unknown> {
    return undefined;
  },
  async after(_run: Run, _before: unknown): Promise<void> {
    throw new Error("B7-followups not merged");
  },
};
