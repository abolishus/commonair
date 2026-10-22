// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E3 end to end (docs/testing/e3-selectors.md, "The e2e-relay scenario"): a member
 * creates a relay on `/relays`, the harness builds and runs the Go relay on the host's LAN address
 * with that token, honest viewers land on it, a viewbot swarm is excluded, the relay's receipts
 * verify against the origin's issuance and the verified count is exactly the honest audience. A
 * TypeScript relay that over-reports 5× is suspended and its viewers move to the origin. Finally
 * the Go relay drains on SIGTERM (offline, players back on the origin), comes back with the same
 * token, and the member retires it.
 *
 * Knobs: `--set relayHost=<addr> relayPort=<n> httpViewers=4 browserViewers=2 bots=12 liar=true
 * drain=true via=web|api` (see src/relay-plan.ts). `via=api` creates and retires relays through
 * the API and uses HTTP viewers only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ApiClient } from "../src/api/client.ts";
import { HttpViewer } from "../src/http-viewer.ts";
import { LiarRelay } from "../src/liar-relay.ts";
import { playerBundles } from "../src/player-server.ts";
import { GoRelay, buildRelay, freePort, relayHost } from "../src/relay.ts";
import { type RelayPlan, buildRelayPlan, verifiedCountOk } from "../src/relay-plan.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { type ScenarioContext, defineScenario } from "../src/scenario.ts";
import type { SignedInUser } from "../src/users.ts";
import { ViewbotSwarm } from "../src/viewbot.ts";
import { waitFor } from "../src/wait.ts";
import { signInViaUi, signUpViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T, tid } from "../src/web/selectors.ts";
import { WebSession, byTestId, readValue } from "../src/web/session.ts";

/** Bounds from e3-selectors. */
export const RELAY_ACTIVE_TIMEOUT_MS = 60_000;
export const VERIFY_WINDOW_MS = 6 * 60_000;
export const DRAIN_OFFLINE_TIMEOUT_MS = 15_000;
export const DRAIN_SWITCH_TIMEOUT_MS = 30_000;
/** Two over-reporting receipts (one per minute) + the 120 s verify grace + the 60 s job: ~5 min. */
export const SUSPENSION_TIMEOUT_MS = 8 * 60_000;
/** A heartbeat (with jitter) after the relay leaves the active set. */
const SWITCH_TIMEOUT_MS = 90_000;
const UI_TIMEOUT_MS = 20_000;
const PLAYING_TIMEOUT_MS = 60_000;
const LIVE_TIMEOUT_MS = 30_000;
const OFFLINE_TIMEOUT_MS = 60_000;

const RELAY_NAME = "harness-relay";
const LIAR_NAME = "liar";
/** Never let a screenshot show a relay token or stream key. */
const REDACT = [tid(T.relayToken), tid(T.relayRunCommand), tid(T.streamKey)];

type RelayNode = Awaited<ReturnType<ApiClient["relays"]["mine"]>>[number];

/** What the harness reads about a relay, from the `/relays` row (web) or `relays.mine` (api). */
export interface RelayRead {
  status: string;
  bytesVerified: number;
  receipts: { pending: number; verified: number; rejected: number };
  suspendedReason: boolean;
}

export function readFromNode(n: RelayNode): RelayRead {
  return {
    status: n.status,
    bytesVerified: n.bytesVerified30d,
    receipts: n.receipts30d,
    suspendedReason: n.suspendedReason !== null,
  };
}

interface RelayView {
  read(id: string): Promise<RelayRead | null>;
}

class ApiRelayView implements RelayView {
  constructor(private readonly api: ApiClient) {}
  async read(id: string): Promise<RelayRead | null> {
    const node = (await this.api.relays.mine()).find((r) => r.id === id);
    return node ? readFromNode(node) : null;
  }
}

/** Reads `relay-row` on the member's `/relays` page (it refreshes itself every 10 s). */
class WebRelayView implements RelayView {
  constructor(private readonly page: Page) {}
  async read(id: string): Promise<RelayRead | null> {
    const row = this.page.locator(tid(T.relayRow, { "relay-id": id }));
    if ((await row.count()) === 0) return null;
    const attr = async (testId: (typeof T)[keyof typeof T], name: string) =>
      Number(
        (await row
          .locator(tid(testId))
          .first()
          .getAttribute(name, { timeout: 2_000 })
          .catch(() => null)) ?? NaN,
      );
    return {
      status: (await row.first().getAttribute("data-status")) ?? "",
      bytesVerified: await attr(T.relayBytesVerified, "data-bytes"),
      receipts: {
        pending: await attr(T.relayReceipts, "data-pending"),
        verified: await attr(T.relayReceipts, "data-verified"),
        rejected: await attr(T.relayReceipts, "data-rejected"),
      },
      suspendedReason: (await row.locator(tid(T.relaySuspendedReason)).count()) > 0,
    };
  }
}

interface BrowserWatcher {
  label: string;
  session: WebSession;
  page: Page;
  source: string | null;
  attempts: number;
}

export default defineScenario({
  name: "e2e-relay",
  description:
    "member creates a relay on /relays → Go relay on the LAN serves honest viewers → viewbots excluded → receipts verified, count = honest → 5× liar relay suspended, its viewers back on origin → SIGTERM drain offline → restart active → retire",
  needs: ["api", "web", "mail", "media", "origin", "worker", "relay", "ffmpeg", "browser"],
  // Needs Go and OUTBOUND_ALLOW_PRIVATE_NETWORKS=true (the harness stack sets it) and runs
  // ~15 minutes: `full` runs it last (ADR 0021).
  inFull: true,
  timeoutMs: 30 * 60_000,
  async run(ctx) {
    const plan = buildRelayPlan(ctx.params);
    ctx.data("plan", plan);
    const sessions: WebSession[] = [];
    const state = { finished: false, softFailed: false };
    const logs: { relay: GoRelay | null; liar: LiarRelay | null } = { relay: null, liar: null };
    // Registered first so they run last: relay logs (complete on failure) and screenshots.
    ctx.defer(async () => {
      const failed = !state.finished || state.softFailed;
      if (logs.relay) ctx.data("relay.logs", logs.relay.logs.lines(failed ? undefined : 50));
      if (logs.liar) {
        ctx.data("liar.logs", logs.liar.logs.lines(failed ? undefined : 50));
        ctx.data("liar.receipts", logs.liar.receipts);
      }
      if (failed) await screenshotSessions(ctx, sessions);
      await Promise.allSettled(sessions.map((s) => s.close()));
    });
    const check: ScenarioContext["check"] = (name, condition, details) => {
      if (!condition) state.softFailed = true;
      return ctx.check(name, condition, details);
    };
    await e2eRelay(ctx, plan, sessions, logs, check);
    state.finished = true;
  },
});

async function screenshotSessions(ctx: ScenarioContext, sessions: readonly WebSession[]): Promise<void> {
  const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
  const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir, REDACT)))).flat();
  if (files.length > 0) ctx.data("screenshots", files);
}

async function e2eRelay(
  ctx: ScenarioContext,
  plan: RelayPlan,
  sessions: WebSession[],
  logs: { relay: GoRelay | null; liar: LiarRelay | null },
  check: ScenarioContext["check"],
): Promise<void> {
  const p = ctx.platform;
  const signal = ctx.signal;
  const ui = { timeout: UI_TIMEOUT_MS };
  const web = plan.via === "web";
  const { probe } = web ? await playerBundles() : { probe: "" };
  const openSession = async (label: string) => {
    const s = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label,
      log: ctx.log,
    });
    sessions.push(s);
    return s;
  };
  const poll = <R>(
    what: string,
    fn: () => Promise<R | null | undefined | false>,
    timeoutMs: number,
    intervalMs = 1_000,
  ) => waitFor(what, fn, { timeoutMs, intervalMs, signal });

  // ── 1. Setup ──────────────────────────────────────────────────────────────────────────────
  const streamer = await ctx.step("sign up the streamer S (API)", () => p.signUp({ prefix: "e3_st" }));
  const channel = streamer.me.channelSlug ?? streamer.username;
  const encoder = await ctx.step("rotate the stream key", () => p.streamerFor(streamer, { protocol: "rtmp" }));
  ctx.defer(() => encoder.stop());
  await ctx.step("S: publish the RTMP test pattern", () => encoder.start());
  ctx.metric(
    "time_to_live",
    await ctx.step("channel goes live (API)", () => p.waitForLive(channel, true, LIVE_TIMEOUT_MS)),
    "ms",
  );

  let member: SignedInUser;
  let relayPage: Page | null = null;
  let relayId: string;
  let relayToken: string;
  if (web) {
    const creds = p.users.credentials({ prefix: "e3_m" });
    const ms = await openSession("member");
    await signUpViaUi({
      session: ms,
      creds,
      mailpit: p.mailpit,
      webUrl: ctx.env.HARNESS_WEB_URL,
      timeoutMs: UI_TIMEOUT_MS,
      signal,
      step: (name, fn) => ctx.step(name, fn),
    });
    // An API session of the same member, for reads the report needs (ids, counts).
    member = await ctx.step("M: API session", () => p.users.signIn(creds));
    relayPage = await ctx.step("M: open /relays from relays-link", async () => {
      const page = await ms.goto(ROUTES.dashboard);
      await byTestId(page, T.relaysLink).first().click(ui);
      await byTestId(page, T.relays).waitFor(ui);
      check("relays page starts empty", (await byTestId(page, T.relaysEmpty).count()) > 0);
      return page;
    });
    const page = relayPage;
    relayToken = await ctx.step(`M: create relay ${RELAY_NAME} and read the token`, async () => {
      await byTestId(page, T.relayCreateName).fill(RELAY_NAME, ui);
      await byTestId(page, T.relayCreateSubmit).click(ui);
      const token = await poll(
        "relay-token",
        async () => (await readValue(byTestId(page, T.relayToken), UI_TIMEOUT_MS)) || null,
        UI_TIMEOUT_MS,
        250,
      );
      const command = await readValue(byTestId(page, T.relayRunCommand), UI_TIMEOUT_MS);
      check(
        "relay-run-command carries the token and --public-url",
        command.includes(`--token ${token}`) && command.includes("--public-url"),
        {
          startsWith: command.split(" ")[0],
        },
      );
      return token;
    });
    relayId = await ctx.step("M: relay id from relays.mine", async () => {
      const node = (await member.api.client.relays.mine()).find((r) => r.name === RELAY_NAME);
      if (!node) throw new Error(`relays.mine has no ${RELAY_NAME}`);
      await byTestId(page, T.relayRow, { "relay-id": node.id }).waitFor(ui);
      return node.id;
    });
  } else {
    member = await ctx.step("sign up the member M (API)", () => p.signUp({ prefix: "e3_m" }));
    const created = await ctx.step(`M: relays.create ${RELAY_NAME}`, () =>
      member.api.client.relays.create({ name: RELAY_NAME }),
    );
    relayId = created.relayId;
    relayToken = created.registrationToken;
  }
  ctx.assert("registration token looks like a relay token", /^relay_[A-Za-z0-9_-]{43}$/.test(relayToken));
  const view: RelayView = relayPage ? new WebRelayView(relayPage) : new ApiRelayView(member.api.client);
  const waitRelay = (id: string, what: string, ok: (r: RelayRead) => boolean, timeoutMs: number) =>
    poll(
      `relay ${what}`,
      async () => {
        const r = await view.read(id);
        return r && ok(r) ? r : null;
      },
      timeoutMs,
    );

  const host = relayHost(plan.relayHost);
  const port = plan.relayPort ?? (await freePort());
  ctx.data("relay.publicUrl", `http://${host}:${port}`);
  const binary = await ctx.step("build the Go relay (cached by source hash)", () => buildRelay({ log: ctx.log }));
  const dataDir = mkdtempSync(join(tmpdir(), "commonair-relay-data-"));
  ctx.defer(() => rmSync(dataDir, { recursive: true, force: true }));
  const goRelay = new GoRelay(
    { binary, api: ctx.env.HARNESS_API_URL, host, port, dataDir, token: relayToken },
    ctx.log,
  );
  logs.relay = goRelay;
  ctx.defer(() => goRelay.stop());
  const relayStarted = Date.now();
  await ctx.step("start the Go relay and wait for /healthz", async () => {
    goRelay.start();
    await goRelay.waitHealthy(30_000, signal);
  });
  await ctx.step(`relay-row data-status=active within ${RELAY_ACTIVE_TIMEOUT_MS / 1000} s`, () =>
    waitRelay(relayId, "active", (r) => r.status === "active", RELAY_ACTIVE_TIMEOUT_MS),
  );
  const activeAt = Date.now();
  ctx.metric("relay.active_latency", activeAt - relayStarted, "ms");

  // ── 2. Honest viewers on the relay ────────────────────────────────────────────────────────
  const http: HttpViewer[] = [];
  const browsers: BrowserWatcher[] = [];
  ctx.defer(() => Promise.allSettled(http.map((v) => v.stop())));
  const openHttp = async (id: string) => {
    const v = new HttpViewer({ id, target: { channel }, api: p.api().client, log: ctx.log });
    http.push(v);
    await v.start();
    return v;
  };
  const onRelay = (v: HttpViewer, id: string) => v.assignment?.source === "relay" && v.assignment.relayId === id;
  const honestCount = () => http.length + browsers.length;
  const relayAssigned = () =>
    http.filter((v) => onRelay(v, relayId)).length + browsers.filter((b) => b.source === "relay").length;

  if (plan.browserViewers > 0) {
    await ctx.step(`open ${plan.browserViewers} Chromium players on /${channel}`, async () => {
      for (let i = 0; i < plan.browserViewers; i++) {
        const signedIn = i % 2 === 0;
        const label = signedIn ? `fan${i}` : `anon${i}`;
        const s = await openSession(label);
        if (signedIn) {
          const fan = await p.signUp({ prefix: "e3_fan" });
          const page = await s.goto(ROUTES.signin);
          await signInViaUi(page, fan, UI_TIMEOUT_MS, signal);
        }
        const page = await s.goto(ROUTES.channel(channel));
        const w: BrowserWatcher = { label, session: s, page, source: null, attempts: 0 };
        w.source = await playingSource(page);
        browsers.push(w);
      }
    });
    // Assignment is per session: a reload is a new session. Try to get one player on the relay.
    for (const w of browsers) {
      while (
        relayAssigned() < plan.minRelayAssigned &&
        !browsers.some((b) => b.source === "relay") &&
        w.attempts < plan.browserRelayAttempts
      ) {
        w.attempts++;
        w.page = await ctx.step(`${w.label}: reload for a new session (${w.attempts})`, () =>
          w.session.goto(ROUTES.channel(channel)),
        );
        w.source = await playingSource(w.page);
      }
    }
  }
  for (let i = 0; i < plan.httpViewers; i++) await openHttp(`honest-${i}`);
  await ctx.step(`open sessions until ${plan.minRelayAssigned} are relay-assigned`, async () => {
    while (relayAssigned() < plan.minRelayAssigned && honestCount() < plan.maxSessions)
      await openHttp(`honest-${http.length}`);
  });
  const assignedHttp = http.filter((v) => onRelay(v, relayId));
  ctx.data("assignment", {
    honest: honestCount(),
    relayAssigned: relayAssigned(),
    browsers: browsers.map((b) => ({ label: b.label, source: b.source, reloads: b.attempts })),
  });
  ctx.assert(
    `at least ${plan.minRelayAssigned} honest sessions are relay-assigned`,
    relayAssigned() >= plan.minRelayAssigned,
    {
      relayAssigned: relayAssigned(),
      opened: honestCount(),
    },
  );
  const firstFrames = await ctx.step("honest HTTP viewers play", () =>
    Promise.allSettled(http.map((v) => v.waitForFirstFrame(PLAYING_TIMEOUT_MS))),
  );
  ctx.assert(
    "every honest HTTP viewer plays",
    firstFrames.every((r) => r.status === "fulfilled"),
    {
      failed: firstFrames
        .flatMap((r, i) => (r.status === "rejected" ? [`${http[i]?.id}: ${String(r.reason)}`] : []))
        .slice(0, 5),
    },
  );
  const relayTtff = assignedHttp.flatMap((v) => {
    const r = firstFrames[http.indexOf(v)];
    return r?.status === "fulfilled" ? [r.value] : [];
  });
  if (relayTtff.length > 0) ctx.metric("relay.first_playback", Math.min(...relayTtff), "ms");
  if (browsers.length > 0) {
    check(
      "every Chromium player is playing",
      browsers.every((b) => b.source !== null),
      browsers.map((b) => b.source),
    );
  }
  await ctx.step("relay /healthz reports viewers ≥ 2", () =>
    poll(
      "relay /healthz viewers",
      async () => {
        const h = await goRelay.health();
        return h && h.viewers >= Math.min(2, relayAssigned()) ? h : null;
      },
      30_000,
    ),
  );

  // ── 3. Viewbot swarm ──────────────────────────────────────────────────────────────────────
  const swarm = new ViewbotSwarm({ channel, sessions: plan.bots }, p.datacenter, (o) => p.api(o), p.log);
  ctx.defer(() => swarm.stop());
  if (plan.bots > 0) await ctx.step(`start ${plan.bots} viewbots`, () => swarm.start());
  const botsOnRelay = swarm.members.filter((v) => onRelay(v, relayId)).length;
  ctx.metric("counts.bots", plan.bots);
  ctx.metric("counts.bots_relay_assigned", botsOnRelay);

  // ── 4. Verification (one 6-minute window for all of it) ───────────────────────────────────
  const verifyDeadline = Date.now() + VERIFY_WINDOW_MS;
  const remaining = () => Math.max(1_000, verifyDeadline - Date.now());
  let maxPublic = 0;
  const samplePublic = async () => {
    const c = await p.viewerCount(channel).catch(() => null);
    if (c !== null) maxPublic = Math.max(maxPublic, c);
  };
  const receipts = await ctx.step("receipts: verified ≥ 1, bytes verified > 0", () =>
    waitRelay(relayId, "receipts verified", (r) => r.receipts.verified >= 1 && r.bytesVerified > 0, remaining()),
  );
  ctx.metric("relay.time_to_receipts_verified", Date.now() - activeAt, "ms");
  ctx.assert("no rejected receipts for the honest relay", receipts.receipts.rejected === 0, receipts);
  ctx.metric("relay.bytes_verified", receipts.bytesVerified, "bytes");

  const health = () => streamer.api.client.stream.health({ channel }).then((h) => h.viewers);
  let lastViewers = { verified: 0, pending: 0, excluded: 0 };
  await ctx
    .step("counts: verified = honest, excluded ≥ bots", () =>
      poll(
        "verified = honest and bots excluded",
        async () => {
          await samplePublic();
          lastViewers = await health();
          return lastViewers.verified === honestCount() && lastViewers.excluded >= plan.bots;
        },
        remaining(),
        2_000,
      ),
    )
    .catch((err: unknown) => {
      throw new Error(`${(err as Error).message}; last ${JSON.stringify(lastViewers)} with ${honestCount()} honest`);
    });
  ctx.metric("counts.honest", honestCount());
  ctx.metric("counts.relay_assigned", relayAssigned());
  ctx.metric("counts.verified", lastViewers.verified);
  ctx.metric("counts.excluded", lastViewers.excluded);
  await samplePublic();
  ctx.assert("the public count never exceeded the honest count", maxPublic <= honestCount(), {
    maxPublic,
    honest: honestCount(),
  });
  await checkRelaySessionVerdicts(
    ctx,
    check,
    assignedHttp.flatMap((v) => (v.sessionId ? [v.sessionId] : [])),
  );

  // ── 5. Over-reporting relay ──────────────────────────────────────────────────────────────
  let liarAssigned = 0;
  if (plan.liar) {
    const created = await ctx.step(`M: relays.create ${LIAR_NAME}`, () =>
      member.api.client.relays.create({ name: LIAR_NAME }),
    );
    const liarId = created.relayId;
    const liar = new LiarRelay({
      apiUrl: ctx.env.HARNESS_API_URL,
      token: created.registrationToken,
      host,
      port: await freePort(),
      factor: plan.liarFactor,
      log: ctx.log,
    });
    logs.liar = liar;
    ctx.defer(() => liar.stop());
    const liarStarted = Date.now();
    await ctx.step("start the liar relay and register it", () => liar.start());
    await ctx.step("liar relay active", () =>
      waitRelay(liarId, "liar active", (r) => r.status === "active", RELAY_ACTIVE_TIMEOUT_MS),
    );
    const onLiar: HttpViewer[] = [];
    await ctx.step(`open HTTP viewers until ${plan.liarViewers} land on the liar`, async () => {
      const limit = honestCount() + plan.maxSessions;
      while (onLiar.length < plan.liarViewers && honestCount() < limit) {
        const v = await openHttp(`honest-${http.length}`);
        if (onRelay(v, liarId)) onLiar.push(v);
      }
    });
    liarAssigned = onLiar.length;
    ctx.metric("counts.liar_assigned", liarAssigned);
    ctx.assert(`at least ${plan.liarViewers} sessions landed on the liar`, liarAssigned >= plan.liarViewers, {
      liarAssigned,
      honest: honestCount(),
    });
    const knownOnLiar = () =>
      [...http, ...swarm.members].filter((v) => onRelay(v, liarId)).flatMap((v) => (v.sessionId ? [v.sessionId] : []));
    liar.assign(knownOnLiar());
    const liarFrames = await ctx.step("the liar serves its viewers (pass-through)", () =>
      Promise.allSettled(onLiar.map((v) => v.waitForFirstFrame(PLAYING_TIMEOUT_MS))),
    );
    ctx.assert(
      "liar-assigned viewers play through the liar",
      liarFrames.every((r) => r.status === "fulfilled"),
      {
        failed: liarFrames.filter((r) => r.status === "rejected").length,
      },
    );
    const suspended = await ctx.step("liar: relay-row data-status=suspended with a reason", () =>
      waitRelay(
        liarId,
        "liar suspended",
        (r) => {
          liar.assign(knownOnLiar());
          return r.status === "suspended" && r.suspendedReason;
        },
        SUSPENSION_TIMEOUT_MS,
      ),
    );
    const suspendedAt = Date.now();
    ctx.metric("liar.time_to_suspension", suspendedAt - liarStarted, "ms");
    check("the liar's receipts were rejected", suspended.receipts.rejected >= 1, suspended.receipts);
    check(
      "the API accepted the liar's signed receipts for checking",
      liar.receipts.some((r) => r.receiptId !== null),
      liar.receipts.map((r) => r.error ?? r.status),
    );
    const switched = await ctx
      .step("liar-assigned viewers move to the origin", () =>
        poll(
          "liar viewers on origin",
          async () => (onLiar.every((v) => v.assignment?.source === "origin") ? true : null),
          SWITCH_TIMEOUT_MS,
        ),
      )
      .then(
        () => true,
        () => false,
      );
    check(
      "every liar-assigned viewer switched to the origin",
      switched,
      onLiar.map((v) => v.assignment),
    );
    const switchLatency = onLiar.flatMap((v) =>
      v.switchHistory.filter((s) => s.to.source === "origin").map((s) => s.at - suspendedAt),
    );
    if (switchLatency.length > 0) ctx.metric("liar.switch_to_origin", Math.max(0, ...switchLatency), "ms");
    const resumed = await poll(
      "liar viewers playing from the origin",
      async () =>
        onLiar.every((v) => (v.lastSegmentAt ?? 0) > (v.switchHistory.at(-1)?.at ?? Infinity)) ? true : null,
      30_000,
    ).then(
      () => true,
      () => false,
    );
    check("switched viewers keep playing from the origin", resumed);
    let bounded = { verified: 0, pending: 0, excluded: 0 };
    const within = await poll(
      "honest − liar-assigned ≤ verified ≤ honest",
      async () => {
        await samplePublic();
        bounded = await health();
        return verifiedCountOk(bounded.verified, honestCount(), liarAssigned) ? true : null;
      },
      120_000,
      5_000,
    ).then(
      () => true,
      () => false,
    );
    check("honest − liar-assigned ≤ verified ≤ honest", within, { ...bounded, honest: honestCount(), liarAssigned });
    check("the public count never exceeded the honest count", maxPublic <= honestCount(), {
      maxPublic,
      honest: honestCount(),
    });
  }

  // ── 6. Drain, restart, retire ────────────────────────────────────────────────────────────
  if (plan.drain) {
    const relayBrowsers = browsers.filter((b) => b.source === "relay");
    const relayHttp = http.filter((v) => onRelay(v, relayId));
    const t0 = Date.now();
    const exited = goRelay.terminate();
    await ctx.step(`SIGTERM: relay-row data-status=offline within ${DRAIN_OFFLINE_TIMEOUT_MS / 1000} s`, () =>
      waitRelay(relayId, "offline", (r) => r.status === "offline", DRAIN_OFFLINE_TIMEOUT_MS),
    );
    ctx.metric("drain.offline_latency", Date.now() - t0, "ms");
    for (const b of relayBrowsers) {
      await ctx.step(
        `${b.label}: data-source=origin and playing within ${DRAIN_SWITCH_TIMEOUT_MS / 1000} s`,
        async () => {
          await byTestId(b.page, T.player, { source: "origin", state: "playing" }).waitFor({
            timeout: DRAIN_SWITCH_TIMEOUT_MS,
          });
          b.source = "origin";
        },
      );
      ctx.metric(`drain.switch_to_origin.${b.label}`, Date.now() - t0, "ms");
    }
    if (relayBrowsers.length === 0) ctx.log.warn("no Chromium player was relay-assigned: browser switch not observed");
    const httpSwitched = await poll(
      "relay-assigned HTTP viewers on origin",
      async () => (relayHttp.every((v) => v.assignment?.source === "origin") ? true : null),
      SWITCH_TIMEOUT_MS,
    ).then(
      () => true,
      () => false,
    );
    check(
      "relay-assigned HTTP viewers switched to the origin",
      httpSwitched,
      relayHttp.map((v) => v.assignment),
    );
    const code = await ctx.step("the relay exits after its drain", () => exited);
    check("the relay exited cleanly", code === 0, { code });

    const restarted = Date.now();
    await ctx.step("restart the relay with the same token", async () => {
      goRelay.start();
      await goRelay.waitHealthy(30_000, signal);
    });
    await ctx.step("relay back to active", () =>
      waitRelay(relayId, "active again", (r) => r.status === "active", RELAY_ACTIVE_TIMEOUT_MS),
    );
    ctx.metric("relay.restart_active_latency", Date.now() - restarted, "ms");

    await ctx.step(`M: retire ${RELAY_NAME}`, async () => {
      if (relayPage) {
        const row = byTestId(relayPage, T.relayRow, { "relay-id": relayId });
        await row.locator(tid(T.relayRemove)).first().click(ui);
        await byTestId(relayPage, T.confirmDialogConfirm).click(ui);
        await row.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      } else {
        await member.api.client.relays.remove({ id: relayId });
      }
    });
    const listed = (await member.api.client.relays.mine()).some((r) => r.id === relayId);
    ctx.assert("relays.mine omits the retired relay", !listed);
    // Its token no longer authenticates, so there is nothing to drain for: a short grace.
    await ctx.step("stop the retired relay", () => goRelay.terminate(15_000));
  }

  await ctx.step("stop viewers and bots", () => Promise.all([swarm.stop(), ...http.map((v) => v.stop())]));
  await ctx.step("stop publishing", () => encoder.stop());
  ctx.metric(
    "time_to_offline",
    await ctx.step("channel goes offline (API)", () => p.waitForLive(channel, false, OFFLINE_TIMEOUT_MS)),
    "ms",
  );
}

/** Wait for the player to play; returns its `data-source` (null if it never played). */
async function playingSource(page: Page): Promise<string | null> {
  const player = byTestId(page, T.player, { state: "playing" });
  try {
    await player.first().waitFor({ timeout: PLAYING_TIMEOUT_MS });
    return await player.first().getAttribute("data-source");
  } catch {
    return null;
  }
}

/** With `DATABASE_URL` (development), the relay-assigned honest sessions must be `verified`. */
async function checkRelaySessionVerdicts(
  ctx: ScenarioContext,
  check: ScenarioContext["check"],
  ids: string[],
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || ids.length === 0) {
    if (!url) ctx.log.warn("DATABASE_URL not set: relay-assigned verdicts not checked (counts only)");
    return;
  }
  const sql = new Bun.SQL(url);
  try {
    const rows = (await sql`
      select id, verdict::text as verdict from playback_sessions
       where id = any(${sql.array(ids, "uuid")})`) as { id: string; verdict: string }[];
    check("relay-assigned honest sessions are in Postgres", rows.length === ids.length, {
      found: rows.length,
      ids: ids.length,
    });
    check(
      "relay-assigned honest sessions are verified (on receipts)",
      rows.every((r) => r.verdict === "verified"),
      rows.map((r) => r.verdict),
    );
  } finally {
    await sql.close();
  }
}
