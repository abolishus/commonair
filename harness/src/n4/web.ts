// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `federation` scenario's web steps (docs/testing/b7-selectors.md: the `federation-*` test
 * ids), which `src/n4/index.ts` uses when `via=web`: turn federation on in the studio, read the
 * handle, see a follower appear, remove a follower, add an admin domain block. Each signs in its
 * own browser session as `as` and closes it when done. The studio section and the admin page are
 * also checked with axe (`@axe-core/playwright`) the first time a step opens them.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { testIdSelector as tid } from "../w2/rehearsal/checks.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES } from "../web/selectors.ts";
import { WebSession } from "../web/session.ts";

const UI_TIMEOUT_MS = 30_000;
/** A follow arrives through the inbox and a worker job; generous on a loaded runner. */
const FOLLOWER_TIMEOUT_MS = 120_000;
const FOLLOWER_POLL_MS = 3_000;

export const FEDERATION_ROUTES = { studio: "/dashboard", admin: "/admin/federation" } as const;

/** The ids these steps select by (docs/testing/b7-selectors.md "Federation"). */
export const FEDERATION_IDS = {
  settings: "federation-settings",
  enabled: "federation-enabled",
  handle: "federation-handle",
  followers: "federation-followers",
  follower: "federation-follower",
  followerRemove: "federation-follower-remove",
  followersMore: "federation-followers-more",
  adminPage: "federation-admin-page",
  blockDomain: "federation-block-domain",
  blockAdd: "federation-block-add",
  blockConfirm: "federation-block-confirm",
  blocks: "federation-blocks",
  block: "federation-block",
  confirm: "confirm-dialog-confirm",
} as const;
const F = FEDERATION_IDS;

/** An axe result's violation, as far as these steps read it. */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: readonly unknown[];
}

/** The violations that fail a step: serious and critical ones (the rest are recorded only). */
export function blockingViolations(violations: readonly AxeViolation[]): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `axe ${v.id} (${v.impact}): ${v.help} (${v.nodes.length} nodes)`);
}

/** Pages already checked with axe in this run, so a repeated step does not re-scan. */
const axeChecked = new WeakMap<ScenarioContext, Set<string>>();

async function checkAxe(ctx: ScenarioContext, page: Page, testId: string): Promise<void> {
  const seen = axeChecked.get(ctx) ?? new Set<string>();
  axeChecked.set(ctx, seen);
  if (seen.has(testId)) return;
  seen.add(testId);
  const result = await new AxeBuilder({ page }).include(tid(testId)).analyze();
  ctx.data(
    `n4.web.axe.${testId}`,
    result.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
  );
  const blocking = blockingViolations(result.violations);
  ctx.assert(`n4 web: ${testId} has no serious axe violations`, blocking.length === 0, blocking);
}

/** Open a browser session signed in as `as`, run `fn` on `path`, and close the session. */
async function asUser<T>(
  ctx: ScenarioContext,
  as: SignedInUser,
  label: string,
  path: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  try {
    const signin = await session.goto(ROUTES.signin);
    await signInViaUi(signin, as, UI_TIMEOUT_MS, ctx.signal);
    return await fn(await session.goto(path));
  } finally {
    await session.close();
  }
}

async function studioSection(ctx: ScenarioContext, page: Page): Promise<void> {
  await page.locator(tid(F.enabled)).waitFor({ timeout: UI_TIMEOUT_MS });
  await checkAxe(ctx, page, F.settings);
}

/** The streamer turns federation on in the studio stream settings (`federation-enabled`). */
export async function enableFederationViaWeb(ctx: ScenarioContext, as: SignedInUser): Promise<void> {
  await asUser(ctx, as, "n4-streamer", FEDERATION_ROUTES.studio, async (page) => {
    await studioSection(ctx, page);
    const toggle = page.locator(tid(F.enabled));
    // Turning on saves at once (only turning off asks first).
    if ((await toggle.getAttribute("data-state")) !== "on") await toggle.click({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.enabled, { state: "on" })).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.handle)).waitFor({ timeout: UI_TIMEOUT_MS });
  });
}

/** The `@slug@domain` handle the studio shows (`federation-handle`). */
export async function readHandleViaWeb(ctx: ScenarioContext, as: SignedInUser): Promise<string> {
  return asUser(ctx, as, "n4-streamer", FEDERATION_ROUTES.studio, async (page) => {
    await studioSection(ctx, page);
    const handle = page.locator(tid(F.handle));
    await handle.waitFor({ timeout: UI_TIMEOUT_MS });
    const value = await handle.getAttribute("data-handle");
    if (!value) throw new Error("federation-handle carries no data-handle");
    return value;
  });
}

const followerRow = (page: Page, actorId: string) =>
  page.locator(`${tid(F.follower)}[data-actor="${actorId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`);

/** Whether `actorId` is listed, opening further pages of the list until it shows or the list ends. */
async function findFollower(page: Page, actorId: string): Promise<boolean> {
  await page.locator(tid(F.followers)).waitFor({ timeout: UI_TIMEOUT_MS });
  for (;;) {
    if ((await followerRow(page, actorId).count()) > 0) return true;
    const more = page.locator(tid(F.followersMore));
    if ((await more.count()) === 0) return false;
    const before = await page.locator(tid(F.follower)).count();
    await more.click({ timeout: UI_TIMEOUT_MS });
    await waitFor("the next followers page", async () => (await page.locator(tid(F.follower)).count()) > before, {
      timeoutMs: UI_TIMEOUT_MS,
      intervalMs: 200,
    });
  }
}

/** Wait until `actorId` is listed among the followers (`federation-followers`). */
export async function waitForFollowerViaWeb(ctx: ScenarioContext, as: SignedInUser, actorId: string): Promise<void> {
  await asUser(ctx, as, "n4-streamer", FEDERATION_ROUTES.studio, async (page) => {
    await studioSection(ctx, page);
    let first = true;
    await waitFor(
      `follower ${actorId} listed in the studio`,
      async () => {
        // The list loads once per page view: reload to see a follow the worker applied since.
        if (!first) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: UI_TIMEOUT_MS });
          await page.locator(tid(F.enabled)).waitFor({ timeout: UI_TIMEOUT_MS });
        }
        first = false;
        return findFollower(page, actorId);
      },
      { timeoutMs: FOLLOWER_TIMEOUT_MS, intervalMs: FOLLOWER_POLL_MS, signal: ctx.signal },
    );
  });
}

/** Remove the follower `actorId` through its confirm (`federation-follower-remove`). */
export async function removeFollowerViaWeb(ctx: ScenarioContext, as: SignedInUser, actorId: string): Promise<void> {
  await asUser(ctx, as, "n4-streamer", FEDERATION_ROUTES.studio, async (page) => {
    await studioSection(ctx, page);
    if (!(await findFollower(page, actorId))) throw new Error(`follower ${actorId} is not listed`);
    const row = followerRow(page, actorId);
    await row.locator(tid(F.followerRemove)).click({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.confirm)).click({ timeout: UI_TIMEOUT_MS });
    await row.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
  });
}

/** An admin blocks `domain` on `/admin/federation` (`federation-block-add`, `federation-blocks`). */
export async function addDomainBlockViaWeb(ctx: ScenarioContext, as: SignedInUser, domain: string): Promise<void> {
  await asUser(ctx, as, "n4-admin", FEDERATION_ROUTES.admin, async (page) => {
    await page.locator(tid(F.blockDomain)).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.blocks)).waitFor({ timeout: UI_TIMEOUT_MS });
    await checkAxe(ctx, page, F.adminPage);
    await page.locator(tid(F.blockDomain)).fill(domain, { timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.blockAdd)).click({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.blockConfirm)).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(F.confirm)).click({ timeout: UI_TIMEOUT_MS });
    // The page stores the normalized (lower-case) domain.
    await page.locator(tid(F.block, { domain: domain.trim().toLowerCase() })).waitFor({ timeout: UI_TIMEOUT_MS });
  });
}
