// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E7, the admin pages (docs/testing/e7-selectors.md, scenario `e7-admin`):
 *
 * 1. Egress: a streamer publishes a test pattern and an HTTP viewer watches it, so the worker
 *    writes `egress_samples`; `/admin/egress` shows a row for that broadcast with origin bytes.
 * 2. Incidents: an admin opens an incident on `postgres` on `/admin/incidents`; `instance.status`
 *    lists it and marks the component degraded; the admin resolves it (confirm dialog) and the
 *    status page shows it resolved. Audit: `incident.open`, `incident.resolve` by that admin.
 * 3. Integrity: a `pending_review` flag is seeded on a fresh viewer's session (owner DB
 *    connection: the scorer only writes flags with an exclusion); the admin allows it with a
 *    reason on `/admin/integrity`. The flag is `allowed` with `decided_by`, and the audit row
 *    `integrity.flag.decide` carries the reason.
 *
 * `--set via=api` drives the same steps through the API instead of the pages.
 * `--set egressSeconds=180` bounds the wait for the first egress sample.
 *
 * Needs `DATABASE_URL` (role CLI, the seeded flag and the audit checks).
 */
import { join } from "node:path";
import {
  SEEDED_SIGNAL,
  auditRows,
  decideFlagOnPage,
  egressRange,
  egressRowOnPage,
  flagState,
  incidentOnStatus,
  notOperational,
  openIncidentOnPage,
  resolveIncidentOnPage,
  seedPendingFlag,
} from "../src/e7/admin.ts";
import { E7_ROUTES } from "../src/e7/selectors.ts";
import { grantRole } from "../src/money-db.ts";
import { parseVia } from "../src/money.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";
import { waitFor } from "../src/wait.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";
import { WebSession, byTestId } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 20_000;
/** `instance.status` is cached for 10 s. */
const STATUS_SETTLE_MS = 30_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;
/** The incident's component: the API's own database probe, always on the status page. */
const COMPONENT = "postgres";
const REASON = "harness e7-admin: known test network";

export default defineScenario({
  name: "e7-admin",
  description:
    "Egress page shows the scenario's broadcast with origin bytes → an incident opened on postgres degrades it on the status page, then resolves → a seeded pending integrity flag is allowed with a reason (audited)",
  needs: ["api", "web", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const sessions: WebSession[] = [];
    let finished = false;
    ctx.defer(async () => {
      if (!finished) {
        const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
        const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
        if (files.length > 0) ctx.data("screenshots", files);
      }
      await Promise.allSettled(sessions.map((s) => s.close()));
    });
    await e7Admin(ctx, sessions);
    finished = true;
  },
});

async function e7Admin(ctx: ScenarioContext, sessions: WebSession[]): Promise<void> {
  const p = ctx.platform;
  const via = parseVia(ctx.param("via", "web"));
  const egressMs = ctx.intParam("egressSeconds", 180) * 1000;
  ctx.data("via", via);
  const databaseUrl = ctx.env.DATABASE_URL;
  ctx.assert(
    "DATABASE_URL is set (role CLI, seeded flag and audit checks; run from the repo root so Bun loads .env)",
    databaseUrl !== undefined,
  );
  if (databaseUrl === undefined) return;
  const budget = { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal };

  const signedUp = await ctx.step("sign up admin (API)", () => p.signUp({ prefix: "e7adm" }));
  await ctx.step("grant admin (operator CLI)", () =>
    grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const admin = await ctx.step("admin: sign in again to pick up the role", () => p.users.signIn(signedUp));

  const { probe } = via === "web" ? await playerBundles() : { probe: "" };
  let adminWeb: WebSession | null = null;
  const adminPage = async (path: string) => {
    if (!adminWeb) {
      const session = await WebSession.open({
        fleet: p.fleet,
        engine: "chromium",
        webUrl: ctx.env.HARNESS_WEB_URL,
        probeScript: probe,
        label: "admin",
        log: ctx.log,
      });
      sessions.push(session);
      await ctx.step("admin: sign in through the web UI", async () => {
        const page = await session.goto(ROUTES.signin);
        await signInViaUi(page, admin, UI_TIMEOUT_MS, ctx.signal);
        await byTestId(page, T.navUser, { username: admin.username }).waitFor({ timeout: UI_TIMEOUT_MS });
      });
      adminWeb = session;
    }
    return adminWeb.goto(path);
  };

  // 1. Egress ------------------------------------------------------------------------------
  const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: "e7str" }));
  const channel = streamer.me.channelSlug ?? streamer.username;
  const channelId = (await streamer.api.client.channels.get({ channel })).id;
  const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 640, height: 360, bitrateKbps: 800 });
  ctx.defer(() => s.stop());
  await ctx.step("publish a test pattern", () => s.start());
  await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));
  const live = (await p.api().client.channels.get({ channel })).live;
  ctx.assert("the channel reports its broadcast", live !== null);
  if (!live) return;
  const broadcastId = live.id;
  const startedAt = new Date(live.startedAt);
  const viewers = await ctx.step("an HTTP viewer watches", () => p.openViewers(channel, { http: 1 }));
  for (const v of viewers) ctx.defer(() => v.stop());
  await ctx.step("viewer first frame", () => Promise.all(viewers.map((v) => v.waitForFirstFrame(60_000))));

  const apiRow = await ctx.step("admin.egress has origin bytes for the broadcast", () =>
    waitFor(
      "egress samples for the broadcast",
      async () => {
        const r = egressRange(startedAt, new Date());
        const report = await admin.api.client.admin.egress({ from: r.from.toISOString(), to: r.to.toISOString() });
        const row = report.byBroadcast.find((b) => b.broadcastId === broadcastId);
        return row && row.bytes.origin > 0 ? { row, totals: report.totals } : null;
      },
      { timeoutMs: egressMs, intervalMs: 5_000, signal: ctx.signal },
    ),
  );
  ctx.data("egress.api", apiRow);
  ctx.check("the totals cover the broadcast", apiRow.totals.origin >= apiRow.row.bytes.origin, apiRow);
  if (via === "web") {
    const shown = await ctx.step("/admin/egress shows the broadcast's row", () =>
      waitFor(
        "egress-row with origin bytes",
        async () => {
          const page = await adminPage(E7_ROUTES.adminEgress);
          const row = await egressRowOnPage(page, egressRange(startedAt, new Date()), broadcastId, budget);
          return row && row.origin > 0 ? row : null;
        },
        { timeoutMs: 60_000, intervalMs: 2_000, signal: ctx.signal },
      ),
    );
    ctx.data("egress.page", shown);
    ctx.assert("egress-row data-origin > 0", shown.origin > 0, shown);
  }

  // 2. Incidents -----------------------------------------------------------------------------
  const incident = {
    title: `Harness check ${ctx.runId}`.slice(0, 140),
    components: [COMPONENT],
    body: "Scenario e7-admin: opened and resolved by the harness.",
  };
  const incidentId = await ctx.step("open an incident on postgres", async () => {
    if (via === "web") return openIncidentOnPage(await adminPage(E7_ROUTES.adminIncidents), incident, budget);
    return (await admin.api.client.admin.incidents({ ...incident, components: [COMPONENT], status: "investigating" }))
      .id;
  });
  let resolved = false;
  // Never leave the instance's status page degraded by a failed run.
  ctx.defer(async () => {
    if (!resolved)
      await admin.api.client.admin.incidents({
        id: incidentId,
        ...incident,
        components: [COMPONENT],
        status: "resolved",
      });
  });
  const opened = await ctx.step("instance.status lists it and postgres is degraded", () =>
    waitFor(
      "incident on the status page",
      async () => {
        const st = incidentOnStatus(await p.api().client.instance.status(), incidentId, COMPONENT);
        return st.listed && st.incidentStatus === "investigating" && notOperational(st.component) ? st : null;
      },
      { timeoutMs: STATUS_SETTLE_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  ctx.data("incident.opened", opened);

  await ctx.step("resolve the incident", async () => {
    if (via === "web") await resolveIncidentOnPage(await adminPage(E7_ROUTES.adminIncidents), incidentId, budget);
    else
      await admin.api.client.admin.incidents({
        id: incidentId,
        ...incident,
        components: [COMPONENT],
        status: "resolved",
      });
    resolved = true;
  });
  const closed = await ctx.step("instance.status shows it resolved", () =>
    waitFor(
      "resolved incident on the status page",
      async () => {
        const st = incidentOnStatus(await p.api().client.instance.status(), incidentId, COMPONENT);
        return st.incidentStatus === "resolved" && st.resolved ? st : null;
      },
      { timeoutMs: STATUS_SETTLE_MS, intervalMs: 2_000, signal: ctx.signal },
    ),
  );
  ctx.data("incident.closed", closed);
  const incidentAudit = await ctx.step("incident audit rows", () => auditRows(databaseUrl, incidentId));
  const actions = incidentAudit.map((a) => a.action);
  ctx.assert(
    "audit has incident.open then incident.resolve",
    actions[0] === "incident.open" && actions.includes("incident.resolve"),
    {
      actions,
    },
  );
  ctx.check(
    "every incident audit row is the admin's",
    incidentAudit.every((a) => a.actorType === "admin" && a.actorId === admin.id),
    incidentAudit.map((a) => ({ action: a.action, actorType: a.actorType })),
  );
  ctx.check(
    "incident audit details carry no title or body",
    incidentAudit.every((a) => !JSON.stringify(a.details).includes("Harness check")),
  );

  // 3. Integrity -------------------------------------------------------------------------------
  const viewer: SignedInUser = await ctx.step("sign up a fresh viewer", () => p.signUp({ prefix: "e7view" }));
  const session = await ctx.step("viewer starts a playback session", () =>
    viewer.api.client.playback.start({
      channel,
      deviceId: `e7-admin-${crypto.randomUUID()}`.slice(0, 64),
      embed: false,
      p2pCapable: false,
      nativeHls: false,
    }),
  );
  const flagId = await ctx.step("seed a pending_review flag on the session (DB)", () =>
    seedPendingFlag(databaseUrl, { sessionId: session.sessionId, channelId }),
  );
  ctx.data("integrity.flag", { flagId, signal: SEEDED_SIGNAL });
  await ctx.step("allow the flag with a reason", async () => {
    if (via === "web")
      await decideFlagOnPage(
        await adminPage(E7_ROUTES.adminIntegrity),
        { flagId, channel, decision: "allowed", reason: REASON },
        budget,
      );
    else {
      const listed = await admin.api.client.integrity.flags({ channel, decision: "pending_review", limit: 100 });
      ctx.assert(
        "integrity.flags lists the seeded flag",
        listed.items.some((f) => f.id === flagId),
      );
      await admin.api.client.integrity.decide({ id: flagId, decision: "allowed", reason: REASON });
    }
  });
  const state = await ctx.step("the flag is allowed (DB)", () => flagState(databaseUrl, flagId));
  ctx.assert(
    "flag decision is allowed, decided by the admin",
    state.decision === "allowed" && state.decided && state.decidedById === admin.id,
    state,
  );
  const flagAudit = await ctx.step("flag audit row", () => auditRows(databaseUrl, flagId));
  const decide = flagAudit.find((a) => a.action === "integrity.flag.decide");
  ctx.assert(
    "audit has integrity.flag.decide with the reason",
    decide?.reason === REASON && decide.actorId === admin.id,
    {
      actions: flagAudit.map((a) => a.action),
    },
  );
  ctx.check(
    "audit details name the transition",
    decide?.details.from === "pending_review" &&
      decide.details.to === "allowed" &&
      decide.details.signal === SEEDED_SIGNAL,
    decide?.details,
  );
}
