// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extension `group-appeal` (docs/testing/w2-selectors.md, "Scenarios"; ADR
 * 0014 decision 4, batch 6 decision (m)), after `group` and `signed`:
 *
 * - the streamer appeals one of the swarm's shown excluded groups on `/analytics`
 *   (`group-appeal-open` → `group-appeal-submit`), the swarm's `datacenter` group when analytics
 *   shows one (the swarm's sessions take their highest-scoring reason's category, so it can also
 *   be `concurrency` or `automation`);
 * - a second group appeal on the same broadcast is `RATE_LIMITED`;
 * - an admin of its own (signed up here, role granted with the operator CLI) overturns it;
 * - the worker re-runs the rollup: no session of the group is still excluded under it, the rollup
 *   no longer counts the group, and the verified watch time did not go down;
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

/** Sessions that are still excluded under `category` (the rollup's first-reason attribution). */
export const stillInGroup = (sessions: readonly StoredSession[], category: ExclusionCategory): string[] =>
  sessions.filter((s) => s.verdict === "excluded" && firstReasonCategory(s.reasons) === category).map((s) => s.id);

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
    return {
      sessionIds: rows.filter((r) => firstReasonCategory(r.reasons) === category).map((r) => r.id),
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
  const category = pickGroup(view.exclusions, swarmCategories);
  ctx.data("groupAppeal.groups", { shown: view.exclusions, swarm: swarmCategories, category });
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
  ctx.data("groupAppeal.verdicts", { sessions: verdicts.length, verified, rescored: overturned });
  ctx.check("the group's sessions count as verified again", verified > 0, { verified, sessions: verdicts.length });
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
