// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extension `group-appeal` (docs/testing/w2-selectors.md, "Scenarios"; ADR
 * 0014 decision 4, batch 6 decision (m)), after `group` and `signed`:
 *
 * - the streamer appeals one of the swarm's shown excluded groups on `/analytics`
 *   (`group-appeal-open` → `group-appeal-submit`): a group where the threshold rule decides some
 *   session (another category's signal left under the threshold, batch 7 decision (g)) when one is
 *   shown, else the swarm's `datacenter` group when analytics shows one (the swarm's sessions take
 *   their highest-scoring reason's category, so it can also be `concurrency` or `automation`);
 * - a second group appeal on the same broadcast is `RATE_LIMITED`;
 * - an admin of its own (signed up here, role granted with the operator CLI) overturns it;
 * - the worker re-runs the rollup: no session of the group is still excluded under it. What is left
 *   of each session is weighed against the live scorer's threshold (batch 7 decision (g)): a
 *   session whose remaining signals' flagged scores combine (noisy-OR) to at most
 *   `integrity.thresholds.sessionExcludeScore` counts as verified (or pending) again, one whose
 *   remainder still crosses it stays excluded and moves to that group (the swarm's viewbots share
 *   devices and are headless, so their concurrency group moves to `automation`); the rollup no
 *   longer counts the group, and the verified watch time did not go down;
 * - the channel's attestation chain gains a `supersede` entry for the broadcast that verifies
 *   against the instance key history and replaces the broadcast's previous entry.
 */
import type { ExclusionCategory } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { verify } from "@commonair/tokens/attestation";
import { grantRole } from "../money-db.ts";
import { apiError, errorOf } from "../safety.ts";
import { internalSecret } from "../safety-io.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { IntegrityW2Extension } from "./kit.ts";
import { type ByCategory, firstReasonCategory, readRollup } from "./rollup.ts";

const UI_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;
/** The outbox relay, the rollup and the attestation job run one after another on a loaded runner. */
const RERUN_TIMEOUT_MS = 240_000;
const ROLE_CLI_TIMEOUT_MS = 60_000;
const ANALYTICS_ROUTE = "/analytics";
const APPEAL_BODY = "These viewers are one school network watching together (harness).";
const RESOLUTION = "Reviewed the group (harness).";

/**
 * The group to appeal among the shown ones: `datacenter` when shown, else the shown group the
 * swarm put the most sessions in, else the largest shown group; null when none is shown.
 */
export function pickGroup(
  shown: readonly { category: ExclusionCategory; sessions: number }[],
  swarm: ByCategory,
): ExclusionCategory | null {
  if (shown.some((g) => g.category === "datacenter")) return "datacenter";
  const ranked = [...shown].sort(
    (a, b) => (swarm[b.category] ?? 0) - (swarm[a.category] ?? 0) || b.sessions - a.sessions,
  );
  return ranked[0]?.category ?? null;
}

export interface StoredSession {
  id: string;
  verdict: string;
  reasons: string[] | null;
}

/**
 * What an overturn weighs what is left against (`packages/integrity/src/rescore.ts`): the live
 * scorer's threshold and each session's strongest flagged score per signal.
 */
export interface OverturnWeights {
  threshold: number;
  flags: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

/** Mirror of the scorer's noisy-OR (`packages/integrity/src/signals/combine.ts`), rounded at 1e-6. */
export function noisyOr(scores: readonly number[]): number {
  let keep = 1;
  for (const x of scores) keep *= 1 - (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  return Math.round((1 - keep) * 1e6) / 1e6;
}

/** Sessions that are still excluded under `category` (the rollup's first-reason attribution). */
export const stillInGroup = (sessions: readonly StoredSession[], category: ExclusionCategory): string[] =>
  sessions.filter((s) => s.verdict === "excluded" && firstReasonCategory(s.reasons) === category).map((s) => s.id);

/** Mirror of `NON_SIGNAL_REASONS` in packages/integrity/src/rescore.ts: reasons that are not signals. */
const NON_SIGNAL_REASONS: ReadonlySet<string> = new Set([
  "allowed_on_appeal",
  "fetch_unjudged",
  "insufficient_heartbeats",
  "media_unconfirmed",
]);

/**
 * Where an overturn of `category` puts a session with these stored reasons (`rescore.ts`): null
 * when it is verified (or pending) again, else the group it moves to (the first signal left).
 * Without `weights` (the batch 6 rule): nothing of another category left is null. With `weights`
 * (decision (g)) the signals left are weighed: at most the threshold is null too, and what cannot
 * be weighed (a signal left with no flag, or a code no signal knows, which is the `other` group)
 * keeps the session excluded, as the re-score fails closed.
 */
export function expectedAfterOverturn(
  reasons: readonly string[] | null,
  category: ExclusionCategory,
  weights?: { threshold: number; flags: Readonly<Record<string, number>> },
): ExclusionCategory | null {
  const left = (reasons ?? []).filter((r) => NON_SIGNAL_REASONS.has(r) || firstReasonCategory([r]) !== category);
  const next = firstReasonCategory(left);
  if (!weights) return next === "other" ? null : next;
  const signals = left.filter((r) => !NON_SIGNAL_REASONS.has(r));
  const unweighable = signals.some((r) => firstReasonCategory([r]) === "other" || weights.flags[r] === undefined);
  if (unweighable) return next;
  return noisyOr(signals.map((r) => weights.flags[r] ?? 0)) > weights.threshold ? next : null;
}

/** Sessions another category's signal would keep excluded but the threshold restores. */
export function underThreshold(
  sessions: readonly StoredSession[],
  category: ExclusionCategory,
  weights: OverturnWeights,
): string[] {
  return sessions
    .filter((s) => {
      const flags = weights.flags.get(s.id) ?? {};
      return (
        expectedAfterOverturn(s.reasons, category) !== null &&
        expectedAfterOverturn(s.reasons, category, { threshold: weights.threshold, flags }) === null
      );
    })
    .map((s) => s.id);
}

export interface OverturnOutcome {
  /** Sessions that should be verified or pending again and are not. */
  notRestored: string[];
  /** Sessions that should stay excluded under another category and are not. */
  notMoved: string[];
  restorable: number;
  restored: number;
  moved: number;
  /** Of `restorable`, the sessions with another category's signal left under the threshold. */
  underThreshold: number;
  /** Of those, the ones verified or pending again. */
  underThresholdRestored: number;
}

/**
 * Compares the group's sessions before the overturn with their verdicts after it; with `weights`,
 * by the threshold rule (decision (g)).
 */
export function overturnOutcome(
  before: readonly StoredSession[],
  after: readonly StoredSession[],
  category: ExclusionCategory,
  weights?: OverturnWeights,
): OverturnOutcome {
  const now = new Map(after.map((s) => [s.id, s]));
  const out: OverturnOutcome = {
    notRestored: [],
    notMoved: [],
    restorable: 0,
    restored: 0,
    moved: 0,
    underThreshold: 0,
    underThresholdRestored: 0,
  };
  const under = new Set(weights ? underThreshold(before, category, weights) : []);
  for (const s of before) {
    const flags = weights?.flags.get(s.id) ?? {};
    const want = expectedAfterOverturn(
      s.reasons,
      category,
      weights ? { threshold: weights.threshold, flags } : undefined,
    );
    const got = now.get(s.id);
    if (want === null) {
      out.restorable++;
      if (under.has(s.id)) out.underThreshold++;
      if (got && (got.verdict === "verified" || got.verdict === "pending")) {
        out.restored++;
        if (under.has(s.id)) out.underThresholdRestored++;
      } else out.notRestored.push(s.id);
    } else if (got?.verdict === "excluded" && firstReasonCategory(got.reasons) === want) out.moved++;
    else out.notMoved.push(s.id);
  }
  return out;
}

/**
 * Whether the re-run rollup has dropped the appealed group. A session still pending at the
 * overturn was not in the group, so the scorer may still exclude it under the same category
 * before finalize: such newcomers may be counted, the appealed sessions may not.
 */
export function groupDropped(
  appealed: readonly string[],
  rerun: { sessionIds: readonly string[]; counted: number },
): { ok: boolean; newcomers: string[]; returned: string[] } {
  const was = new Set(appealed);
  const returned = rerun.sessionIds.filter((id) => was.has(id));
  const newcomers = rerun.sessionIds.filter((id) => !was.has(id));
  return { ok: returned.length === 0 && rerun.counted <= newcomers.length, newcomers, returned };
}

export interface RollupRow {
  rolledUpAtMs: number;
  verified: number;
  excluded: number;
  bySessions: ByCategory;
}

/**
 * The broadcast's excluded sessions in `category` (every one, the rollup's 1-second floor aside)
 * and its rollup row. Times come back as epoch milliseconds so no driver's timestamp handling is
 * involved (wave-1 CI lesson).
 */
export async function readGroup(url: string, broadcastId: string, category: ExclusionCategory) {
  const sql = new Bun.SQL(url);
  try {
    const rows = (await sql`
      select id::text as id, verdict::text as verdict, verdict_reasons as reasons
        from playback_sessions where broadcast_id = ${broadcastId}::uuid and verdict = 'excluded'
       order by id`) as StoredSession[];
    const [t] = (await sql`
      select (extract(epoch from rolled_up_at) * 1000)::float8 as "rolledUpAtMs",
             verified_viewer_seconds::float8 as verified, excluded_viewer_seconds::float8 as excluded,
             excluded_sessions_by_category as "bySessions"
        from broadcast_audience_totals where broadcast_id = ${broadcastId}::uuid`) as RollupRow[];
    const sessions = rows.filter((r) => firstReasonCategory(r.reasons) === category);
    return {
      sessions,
      sessionIds: sessions.map((r) => r.id),
      rollup: t
        ? { ...t, rolledUpAtMs: Number(t.rolledUpAtMs), verified: Number(t.verified), excluded: Number(t.excluded) }
        : null,
    };
  } finally {
    await sql.close();
  }
}

/** The stored verdicts of the given sessions (ids bound with `sql.array`, wave-1 CI lesson). */
export async function readVerdicts(url: string, ids: readonly string[]): Promise<StoredSession[]> {
  const sql = new Bun.SQL(url);
  try {
    // A plain array (Bun.SQL returns its own result array type).
    return [
      ...((await sql`
      select id::text as id, verdict::text as verdict, verdict_reasons as reasons
        from playback_sessions where id = any(${sql.array([...ids], "uuid")}) order by id`) as StoredSession[]),
    ];
  } finally {
    await sql.close();
  }
}

/**
 * The live scorer's threshold and the sessions' strongest flagged score per signal (what the
 * re-score weighs; `integrity_flags` keeps the scores whatever the flags' decision).
 */
export async function readWeights(url: string, ids: readonly string[]): Promise<OverturnWeights> {
  const sql = new Bun.SQL(url);
  try {
    const [t] = (await sql`
      select (value ->> 'sessionExcludeScore')::float8 as threshold
        from governance_settings where key = 'integrity.thresholds'`) as { threshold: number | null }[];
    const rows = (await sql`
      select subject_id::text as id, signal, max(score)::float8 as score
        from integrity_flags
       where subject_type = 'session' and subject_id = any(${sql.array([...ids], "uuid")})
       group by subject_id, signal`) as { id: string; signal: string; score: number }[];
    const flags = new Map<string, Record<string, number>>();
    for (const r of rows) flags.set(r.id, { ...flags.get(r.id), [r.signal]: Number(r.score) });
    if (t?.threshold === null || t?.threshold === undefined) throw new Error("integrity.thresholds is missing");
    return { threshold: Number(t.threshold), flags };
  } finally {
    await sql.close();
  }
}

/** Every excluded session of the broadcast. */
export async function readExcluded(url: string, broadcastId: string): Promise<StoredSession[]> {
  const sql = new Bun.SQL(url);
  try {
    // A plain array (Bun.SQL returns its own result array type).
    return [
      ...((await sql`
      select id::text as id, verdict::text as verdict, verdict_reasons as reasons
        from playback_sessions where broadcast_id = ${broadcastId}::uuid and verdict = 'excluded'
       order by id`) as StoredSession[]),
    ];
  } finally {
    await sql.close();
  }
}

/**
 * Among the shown groups, the one whose overturn the threshold rule decides for the most sessions
 * (another category's signal left, under the threshold), or null when no shown group has one.
 */
export function pickThresholdGroup(
  shown: readonly { category: ExclusionCategory }[],
  sessions: readonly StoredSession[],
  weights: OverturnWeights,
): ExclusionCategory | null {
  let best: { category: ExclusionCategory; n: number } | null = null;
  for (const g of shown) {
    const inGroup = sessions.filter((s) => firstReasonCategory(s.reasons) === g.category);
    const n = underThreshold(inGroup, g.category, weights).length;
    if (n > 0 && (!best || n > best.n)) best = { category: g.category, n };
  }
  return best?.category ?? null;
}

/** What `group-appeal` found, for `group-appeal-threshold` on the same run. */
export interface GroupAppealResult {
  category: ExclusionCategory;
  weights: OverturnWeights;
  outcome: OverturnOutcome;
}
const appealed = new WeakMap<IntegrityW2Extension, GroupAppealResult>();

interface Entry {
  kind: string;
  broadcastId: string;
  entryHash: string;
  supersedes: string | null;
  seq: number;
  envelope: { payload: string; signature: string };
}

/** A `supersede` entry for the broadcast that was not in the chain before, newest first. */
export function newSupersede(entries: readonly Entry[], broadcastId: string, before: ReadonlySet<string>) {
  return (
    [...entries]
      .filter((e) => e.kind === "supersede" && e.broadcastId === broadcastId && !before.has(e.entryHash))
      .sort((a, b) => b.seq - a.seq)[0] ?? null
  );
}

/** The broadcast's newest entry (what a new `supersede` must replace), or null. */
export function latestFor(entries: readonly Entry[], broadcastId: string): Entry | null {
  return [...entries].filter((e) => e.broadcastId === broadcastId).sort((a, b) => b.seq - a.seq)[0] ?? null;
}

async function bypass(ext: IntegrityW2Extension, enabled: boolean): Promise<void> {
  const secret = internalSecret(ext.ctx.env);
  if (!secret) throw new Error("INTERNAL_API_SECRET is not set: the analytics test hooks need it");
  const res = await fetch(new URL(INTERNAL_ROUTES.analyticsDisplayBypass, ext.ctx.env.HARNESS_API_URL), {
    method: "PUT",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify({ channelId: ext.channelId, enabled }),
    signal: AbortSignal.any([ext.ctx.signal, AbortSignal.timeout(HOOK_TIMEOUT_MS)]),
  });
  if (res.status === 404) throw new Error("the analytics test hooks are off (OPS_TEST_HOOKS=true for the api)");
  if (!res.ok) throw new Error(`display bypass answered HTTP ${res.status}`);
}

export async function stepGroupAppeal(ext: IntegrityW2Extension): Promise<void> {
  const { ctx, channel, streamer } = ext;
  const broadcastId = ext.broadcastId;
  const url = ext.databaseUrl;
  ctx.assert("the scenario's broadcast is known", broadcastId !== null, { broadcastId });
  ctx.assert("the database is reachable (DATABASE_URL)", url !== undefined);
  if (broadcastId === null || url === undefined) return;
  await ext.endBroadcast();
  await ctx.step("bypass the analytics display delay", async () => {
    await bypass(ext, true);
    ctx.defer(() => bypass(ext, false).catch(() => undefined));
  });

  const view = await ctx.step("read the broadcast's excluded groups", () =>
    streamer.api.client.analytics.broadcast({ channel, broadcastId }),
  );
  const { swarmCategories } = await ctx.step("read the swarm's categories", () =>
    readRollup(url, broadcastId, ext.swarmSessionIds),
  );
  // Decision (g): prefer a group whose overturn the threshold rule decides, so the run exercises it.
  const excluded = await ctx.step("read the broadcast's excluded sessions and their flags", async () => {
    const sessions = await readExcluded(url, broadcastId);
    return {
      sessions,
      weights: await readWeights(
        url,
        sessions.map((s) => s.id),
      ),
    };
  });
  const category =
    pickThresholdGroup(view.exclusions, excluded.sessions, excluded.weights) ??
    pickGroup(view.exclusions, swarmCategories);
  ctx.data("groupAppeal.groups", {
    shown: view.exclusions,
    swarm: swarmCategories,
    category,
    threshold: excluded.weights.threshold,
  });
  ctx.assert("analytics shows an excluded group to appeal", category !== null, view.exclusions);
  if (category === null) return;
  const before = await ctx.step("read the group's sessions and the rollup", () =>
    readGroup(url, broadcastId, category),
  );
  ctx.assert("the group's sessions are excluded under it", before.sessionIds.length >= 5 && before.rollup !== null, {
    sessions: before.sessionIds.length,
  });
  if (!before.rollup) return;
  const chainBefore = await ctx.step("read the attestation chain", () =>
    streamer.api.client.integrity.attestations.list({ channel, limit: 100 }),
  );
  const replaced = latestFor(chainBefore.items, broadcastId);
  ctx.assert("the broadcast has a signed entry (the signed step ran)", replaced !== null);
  const knownHashes = new Set(chainBefore.items.map((e) => e.entryHash));

  await ctx.step("the owner appeals the group on /analytics", async () => {
    const session = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: "",
      label: "group-appeal-owner",
      log: ctx.log,
    });
    ctx.defer(() => session.close());
    const signin = await session.goto(ROUTES.signin);
    await signInViaUi(signin, streamer, UI_TIMEOUT_MS, ctx.signal);
    await byTestId(signin, T.navUser, { username: streamer.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    const page = await session.goto(ANALYTICS_ROUTE);
    await page
      .locator(`[data-testid="analytics-broadcast-select"][data-value="${broadcastId}"]`)
      .waitFor({ timeout: UI_TIMEOUT_MS });
    const row = page.locator(`[data-testid="analytics-excluded-group"][data-category="${category}"]`);
    const open = row.locator('[data-testid="group-appeal-open"][data-state="available"]');
    await open.waitFor({ timeout: UI_TIMEOUT_MS });
    await open.click();
    const dialog = page.locator('[data-testid="group-appeal-dialog"]');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    const remaining = await dialog.locator('[data-testid="group-appeal-limit"]').getAttribute("data-remaining");
    ctx.check("the dialog says how many appeals are left this week", remaining !== null && Number(remaining) > 0, {
      remaining,
    });
    await dialog.locator("textarea").fill(APPEAL_BODY);
    await dialog.locator('[data-testid="group-appeal-submit"]').click();
    await page
      .locator('[data-testid="group-appeal-status"][data-status="open"]')
      .first()
      .waitFor({ timeout: UI_TIMEOUT_MS });
    await row.locator('[data-testid="group-appeal-open"][data-state="appealed"]').waitFor({ timeout: UI_TIMEOUT_MS });
  });

  const mine = await ctx.step("read the appeal", () => streamer.api.client.appeals.mine());
  const appeal = mine.find(
    (a) => a.subjectType === "exclusion_group" && a.subjectId === broadcastId && a.exclusionCategory === category,
  );
  ctx.assert("the group appeal is open on the broadcast and category", appeal?.status === "open", { appeal });
  if (!appeal) return;

  const second = await ctx.step("a second group appeal on the broadcast", () =>
    errorOf(() =>
      streamer.api.client.appeals.create({
        kind: "integrity",
        subjectType: "exclusion_group",
        subjectId: broadcastId,
        category: view.exclusions.find((g) => g.category !== category)?.category ?? category,
        body: APPEAL_BODY,
      }),
    ),
  );
  ctx.assert("a second group appeal on the broadcast is rate-limited", apiError(second).code === "RATE_LIMITED", {
    error: apiError(second),
  });

  const admin = await ctx.step("sign up an admin (API)", () => ctx.platform.signUp({ prefix: "ga_admin" }));
  await ctx.step("grant the admin role (operator CLI)", () =>
    grantRole(url, admin.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const staff = await ctx.step("admin: sign in again to pick up the role", () => ctx.platform.users.signIn(admin));
  const overturned = await ctx.step("the admin overturns the group appeal", () =>
    staff.api.client.appeals.resolve({ id: appeal.id, status: "overturned", resolution: RESOLUTION }),
  );
  ctx.assert("the appeal is overturned", overturned.status === "overturned");

  const prior = before.rollup;
  const rerun = await ctx.step("the worker re-runs the rollup", () =>
    waitFor(
      "the rollup re-ran after the overturn",
      async () => {
        const g = await readGroup(url, broadcastId, category);
        return g.rollup && g.rollup.rolledUpAtMs > prior.rolledUpAtMs ? g : null;
      },
      { timeoutMs: RERUN_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const verdicts = await ctx.step("read the group's verdicts", () => readVerdicts(url, before.sessionIds));
  const left = stillInGroup(verdicts, category);
  ctx.assert("no session of the group is still excluded under it", left.length === 0, { left });
  const verified = verdicts.filter((v) => v.verdict === "verified").length;
  const outcome = overturnOutcome(before.sessions, verdicts, category, excluded.weights);
  appealed.set(ext, { category, weights: excluded.weights, outcome });
  ctx.data("groupAppeal.verdicts", { sessions: verdicts.length, verified, outcome, rescored: overturned });
  // Which of the two applies depends on the signals the swarm happened to trip (CI run 41305101320:
  // every concurrency session was also headless, so none could be restored).
  ctx.check(
    "the group's sessions left at or under the threshold count as verified (or pending) again",
    outcome.notRestored.length === 0,
    outcome,
  );
  ctx.check("the group's sessions still over the threshold move to their next group", outcome.notMoved.length === 0, {
    ...outcome,
    reasons: verdicts.filter((v) => outcome.notMoved.includes(v.id)).map((v) => v.reasons),
  });
  const rolled = rerun.rollup;
  const dropped = groupDropped(before.sessionIds, {
    sessionIds: rerun.sessionIds,
    counted: rolled?.bySessions[category] ?? 0,
  });
  ctx.assert("the re-run rollup no longer counts the group", rolled !== null && dropped.ok, {
    rollup: rolled?.bySessions,
    returned: dropped.returned,
    newcomers: dropped.newcomers.length,
  });
  ctx.assert("verified watch time did not go down", rolled !== null && rolled.verified >= prior.verified, {
    before: prior.verified,
    after: rolled?.verified,
  });

  const entry = await ctx.step("the chain gains a supersede entry", () =>
    waitFor(
      "a supersede entry for the broadcast",
      async () => {
        const page = await streamer.api.client.integrity.attestations.list({ channel, limit: 100 });
        return newSupersede(page.items, broadcastId, knownHashes);
      },
      { timeoutMs: RERUN_TIMEOUT_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  const keys = await ctx.step("read the attestation key history", () => streamer.api.client.integrity.keys.list());
  const result = await verify(entry.envelope, keys.keys);
  ctx.assert("the supersede entry verifies", result.ok, result.ok ? undefined : { error: result.error });
  if (!result.ok) return;
  ctx.assert("it replaces the broadcast's previous entry", result.statement.supersedes === replaced?.entryHash, {
    supersedes: result.statement.supersedes,
    replaced: replaced?.entryHash,
  });
  ctx.check(
    "it signs the re-run rollup's figures",
    rolled !== null &&
      result.statement.verifiedViewerSeconds === rolled.verified &&
      result.statement.excludedViewerSeconds === rolled.excluded,
    { statement: result.statement, rollup: rolled },
  );
}

/**
 * `integrity-basic` W3 extension `group-appeal-threshold` (batch 7 decision (g); `src/w3/steps.ts`):
 * after an overturn, a session left with only a sub-threshold signal is verified, and one whose
 * remainder still crosses the threshold stays excluded. Runs after W2's extensions, with `group`
 * and `signed`. A broadcast takes one group appeal a week, so it reads what `group-appeal` found
 * when that ran on this run, and otherwise runs it (it prefers a group the threshold decides).
 */
export async function stepGroupAppealThreshold(ext: IntegrityW2Extension): Promise<void> {
  const { ctx } = ext;
  if (!appealed.has(ext)) await ctx.step("overturn a group (group-appeal)", () => stepGroupAppeal(ext));
  const r = appealed.get(ext);
  ctx.assert("a group appeal was overturned on this run", r !== undefined);
  if (!r) return;
  const { outcome } = r;
  ctx.data("groupAppealThreshold", { category: r.category, threshold: r.weights.threshold, outcome });
  ctx.assert(
    "threshold: every session left at or under it is verified (or pending)",
    outcome.notRestored.length === 0,
    outcome,
  );
  ctx.assert(
    "threshold: every session whose remainder still crosses it stays excluded, in its next group",
    outcome.notMoved.length === 0,
    outcome,
  );
  const name = "threshold: a session left with only a sub-threshold signal is verified (or pending)";
  if (outcome.underThreshold === 0)
    ctx.skipStep(
      name,
      `the ${r.category} group left no session with another signal at or under ${r.weights.threshold}`,
    );
  else ctx.assert(name, outcome.underThresholdRestored === outcome.underThreshold, outcome);
}
