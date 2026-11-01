// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extension `group` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0014,
 * batch 6 decision (k)): end the broadcast, run the rollup now through the analytics test hook
 * (settle override 0), bypass the 24 h display delay, and check that
 *
 * - the API's figures are the rollup's, and the rollup's excluded sessions are the broadcast's
 *   excluded sessions (every swarm session among them);
 * - each excluded group of 5 or more sessions is shown with its rollup counts and the smaller ones
 *   are only counted (`hiddenGroups`), with no signal code in the response;
 * - the swarm is one `datacenter` group of the swarm's size (soft: the category is the first
 *   exclusion reason's, so it depends on how the scorer ranks the swarm's signals);
 * - the studio page shows the same group (`analytics-excluded-group` with `data-category` and
 *   `data-sessions`), signed in through the web form.
 */
import { ANALYTICS_RULES, EXCLUSION_CATEGORIES, type ExclusionCategory } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { internalSecret } from "../safety-io.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { IntegrityW2Extension } from "./kit.ts";

const UI_TIMEOUT_MS = 30_000;
/** The rollup tick waits for the worker; a loaded CI runner needs room. */
const TICK_TIMEOUT_MS = 90_000;
const ANALYTICS_ROUTE = "/analytics";
const GROUP_TEST_ID = "analytics-excluded-group";
/**
 * Signal codes that must never reach an analytics response (decision (k)); `privacy_relay` is
 * also a category name, so it is not listed.
 */
const SIGNAL_CODES = [
  "datacenter_ip",
  "device_concurrency",
  "account_concurrency",
  "headless",
  "heartbeat_inconsistent",
  "fetch_pattern",
  "fetch_unjudged",
];

export type ByCategory = Partial<Record<ExclusionCategory, number>>;
export interface Group {
  category: ExclusionCategory;
  sessions: number;
  viewerSeconds: number;
}

/** What the API should show for a rollup row: groups of at least 5 sessions, the rest counted. */
export function expectedGroups(
  sessions: ByCategory,
  seconds: ByCategory,
  min: number = ANALYTICS_RULES.minGroupSessions,
): { shown: Group[]; hidden: number } {
  const shown: Group[] = [];
  let hidden = 0;
  for (const category of EXCLUSION_CATEGORIES) {
    const n = sessions[category] ?? 0;
    if (n <= 0) continue;
    if (n >= min) shown.push({ category, sessions: n, viewerSeconds: seconds[category] ?? 0 });
    else hidden++;
  }
  return { shown, hidden };
}

/** Differences between the groups the API returned and the expected ones (empty when equal). */
export function groupMismatches(actual: readonly Group[], expected: readonly Group[]): string[] {
  const out: string[] = [];
  const key = (g: Group) => `${g.category}:${g.sessions}:${g.viewerSeconds}`;
  const a = new Set(actual.map(key));
  const e = new Set(expected.map(key));
  for (const k of e) if (!a.has(k)) out.push(`missing ${k}`);
  for (const k of a) if (!e.has(k)) out.push(`unexpected ${k}`);
  return out;
}

/** Signal codes found anywhere in a serialized response. */
export const leakedCodes = (body: unknown): string[] => {
  const text = JSON.stringify(body) ?? "";
  return SIGNAL_CODES.filter((c) => text.includes(c));
};

async function hook(ext: IntegrityW2Extension, path: string, method: string, body: unknown): Promise<Response> {
  const secret = internalSecret(ext.ctx.env);
  if (!secret) throw new Error("INTERNAL_API_SECRET is not set: the analytics test hooks need it");
  const res = await fetch(new URL(path, ext.ctx.env.HARNESS_API_URL), {
    method,
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
    signal: AbortSignal.any([ext.ctx.signal, AbortSignal.timeout(TICK_TIMEOUT_MS)]),
  });
  if (res.status === 404)
    throw new Error(`${path} answered 404: the analytics test hooks are off (OPS_TEST_HOOKS=true for the api)`);
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res;
}

interface RollupRow {
  sessions: number;
  verified: number;
  unverified: number;
  excluded: number;
  bySessions: ByCategory;
  bySeconds: ByCategory;
}

async function readRollup(url: string, broadcastId: string, swarm: readonly string[]) {
  const sql = new Bun.SQL(url);
  try {
    const [t] = (await sql`
      select sessions, verified_viewer_seconds::int as verified, unverified_viewer_seconds::int as unverified,
             excluded_viewer_seconds::int as excluded,
             excluded_sessions_by_category as "bySessions", excluded_seconds_by_category as "bySeconds"
        from broadcast_audience_totals where broadcast_id = ${broadcastId}::uuid`) as RollupRow[];
    const [v] = (await sql`
      select count(*)::int as sessions,
             count(*) filter (where verdict = 'excluded')::int as excluded,
             count(*) filter (where verdict = 'excluded' and id = any(${[...swarm]}::uuid[]))::int as "swarmExcluded"
        from playback_sessions where broadcast_id = ${broadcastId}::uuid`) as {
      sessions: number;
      excluded: number;
      swarmExcluded: number;
    }[];
    return { totals: t ?? null, verdicts: v ?? { sessions: 0, excluded: 0, swarmExcluded: 0 } };
  } finally {
    await sql.close();
  }
}

export async function stepGroup(ext: IntegrityW2Extension): Promise<void> {
  const { ctx, channel, channelId, streamer } = ext;
  const broadcastId = ext.broadcastId;
  ctx.assert("the scenario's broadcast is known", broadcastId !== null, { broadcastId });
  if (broadcastId === null) return;
  await ext.endBroadcast();

  await ctx.step("bypass the analytics display delay", async () => {
    await hook(ext, INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId, enabled: true });
    ctx.defer(() =>
      hook(ext, INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId, enabled: false }).catch(() => undefined),
    );
  });
  const tick = await ctx.step("run the rollup now (settle override)", async () => {
    const res = await hook(ext, INTERNAL_ROUTES.analyticsTick, "POST", {
      job: "broadcast-rollup",
      broadcastId,
      settleSeconds: 0,
    });
    return (await res.json()) as Record<string, number>;
  });
  ctx.data("group.tick", tick);
  ctx.assert("the rollup ran", tick.rolledUp === 1, tick);

  const view = await ctx.step("read the broadcast's analytics", () =>
    streamer.api.client.analytics.broadcast({ channel, broadcastId }),
  );
  ctx.data("group.exclusions", { exclusions: view.exclusions, hiddenGroups: view.hiddenGroups });
  ctx.assert("no signal code in the analytics", leakedCodes(view).length === 0, leakedCodes(view));

  const swarm = ext.swarmSessionIds.length;
  if (ext.databaseUrl) {
    const db = await ctx.step("read the rollup and the verdicts", () =>
      readRollup(ext.databaseUrl as string, broadcastId, ext.swarmSessionIds),
    );
    ctx.data("group.rollup", db);
    const t = db.totals;
    ctx.assert("the broadcast has a rollup row", t !== null);
    if (!t) return;
    ctx.assert(
      "the API's figures are the rollup's",
      view.totals.sessions === t.sessions &&
        view.totals.verifiedViewerSeconds === t.verified &&
        view.totals.unverifiedViewerSeconds === t.unverified &&
        view.totals.excludedViewerSeconds === t.excluded,
      { api: view.totals, rollup: t },
    );
    const rolledExcluded = Object.values(t.bySessions).reduce((a, n) => a + (n ?? 0), 0);
    ctx.assert(
      "the rollup's excluded sessions are the broadcast's excluded sessions, every swarm session among them",
      t.sessions === db.verdicts.sessions &&
        rolledExcluded === db.verdicts.excluded &&
        db.verdicts.swarmExcluded === swarm,
      { rolledExcluded, verdicts: db.verdicts, swarm },
    );
    const expected = expectedGroups(t.bySessions, t.bySeconds);
    const diff = groupMismatches(view.exclusions, expected.shown);
    ctx.assert("groups of 5 or more are shown with their rollup counts", diff.length === 0, diff);
    ctx.assert("smaller groups are only counted", view.hiddenGroups === expected.hidden, {
      api: view.hiddenGroups,
      expected: expected.hidden,
    });
  }
  const datacenter = view.exclusions.find((g) => g.category === "datacenter");
  ctx.check("the swarm is one datacenter excluded group of the swarm's size", datacenter?.sessions === swarm, {
    groups: view.exclusions,
    swarm,
  });

  const shown = datacenter ?? view.exclusions[0];
  if (!shown) return;
  await ctx.step("the studio analytics page shows the group", async () => {
    const session = await WebSession.open({
      fleet: ctx.platform.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: "",
      label: "analytics-owner",
      log: ctx.log,
    });
    ctx.defer(() => session.close());
    const signin = await session.goto(ROUTES.signin);
    await signInViaUi(signin, streamer, UI_TIMEOUT_MS, ctx.signal);
    await byTestId(signin, T.navUser, { username: streamer.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    const page = await session.goto(ANALYTICS_ROUTE);
    await page.locator('[data-testid="analytics-page"]').waitFor({ timeout: UI_TIMEOUT_MS });
    await page
      .locator(`[data-testid="analytics-broadcast-select"][data-value="${broadcastId}"]`)
      .waitFor({ timeout: UI_TIMEOUT_MS });
    const row = page.locator(
      `[data-testid="${GROUP_TEST_ID}"][data-category="${shown.category}"][data-sessions="${shown.sessions}"]`,
    );
    await row.first().waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.assert("the page shows the group once", (await row.count()) === 1, { category: shown.category });
  });
}
