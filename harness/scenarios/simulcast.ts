// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E6, simulcast (docs/testing/e6-selectors.md, "Scenario `simulcast`"): S adds the mock
 * RTMP target on `/dashboard` (key `harness-<runId>`), goes live, the target reports `live` and
 * ffprobe counts frames arriving at the mock target at the source resolution; disabling stops
 * the push and re-enabling restarts it; going offline ends the `simulcast_sessions` row with
 * bytes sent. The key is never in an API response (the harness's own, and on the web path every
 * `/rpc` response the dashboard received), an outbox event or a service log line of the run.
 *
 * `--set via=api` drives the target through `stream.simulcast.*` instead of the dashboard.
 * `--set targetUrl=` overrides the target's RTMP URL as the media service reaches it
 * (default `rtmp://mock-rtmp:1936/live`). The key is only ever passed to ffprobe and the API; it is
 * never logged or written to the report.
 *
 * Needs the harness stack (`harness/compose.e6.yaml`: the `mock-rtmp` service and
 * `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` for api and media).
 */
import type { ApiClient } from "../src/api/client.ts";
import { eventsContaining, simulcastSessions } from "../src/e6/db.ts";
import { type Kit, UI_TIMEOUT_MS, setupKit } from "../src/e6/kit.ts";
import {
  type FrameProbe,
  NO_PUBLISHER_PROBE_S,
  mockRtmpPort,
  mockRtmpReadUrl,
  probeFrames,
  pushStopped,
} from "../src/e6/ffprobe.ts";
import { E6_ROUTES, E6_TEST_IDS as E, byE6Id } from "../src/e6/selectors.ts";
import { RpcResponses, chooseOption, confirmDialog, dataOf, setSwitch } from "../src/e6/web.ts";
import { containerLogs, serviceContainers } from "../src/safety-io.ts";
import { scanLog, summarizeHits, textNeedles } from "../src/safety.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { STREAMER_DEFAULTS } from "../src/streamer.ts";
import type { SignedInUser } from "../src/users.ts";
import { sleep, waitFor } from "../src/wait.ts";
import type { WebSession } from "../src/web/session.ts";

type SimulcastTarget = Awaited<ReturnType<ApiClient["stream"]["simulcast"]["list"]>>[number];

const DEFAULT_TARGET_URL = "rtmp://mock-rtmp:1936/live";
/** Spec: `live` within 20 s of going live; disable/enable effects within 20 s. */
const STATUS_DEADLINE_MS = 20_000;
/**
 * Re-enabling restarts the push. One stalled publish handshake costs the target's 10 s read
 * timeout plus media's reconnect backoff, and counting frames needs a 10 s window: the same
 * 45 s budget as the first push (step 3).
 */
const RESTART_DEADLINE_MS = 45_000;
/** Spec: at least 60 video frames within 10 s. */
const MIN_FRAMES = 60;
const FRAME_WINDOW_S = 10;
/** Grace on top of a spec deadline for polling and ffprobe start-up. */
const SLACK_MS = 10_000;

export default defineScenario({
  name: "simulcast",
  description:
    "S adds the mock RTMP target on /dashboard → goes live → target live, ≥ 60 frames at the source resolution arrive → disable stops / enable restarts the push → offline: session ended with bytes sent; the key is in no API response or service log",
  needs: ["api", "web", "media", "ffmpeg", "browser", "podman"],
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const kit = await setupKit(ctx);
    await simulcast(ctx, kit);
    kit.done();
  },
});

/** Every key-shaped property name a target could leak the key under. */
function keyFields(t: object): string[] {
  return Object.keys(t).filter((k) => /key|secret/i.test(k));
}

async function simulcast(ctx: ScenarioContext, kit: Kit): Promise<void> {
  const p = ctx.platform;
  const startedAt = new Date();
  const key = `harness-${ctx.runId}`;
  const targetUrl = ctx.param("targetUrl", DEFAULT_TARGET_URL);
  const readUrl = mockRtmpReadUrl(key, mockRtmpPort());
  // Every API response of the run that could carry a target, scanned for the key at the end.
  const responses: unknown[] = [];

  const s = await ctx.step("sign up streamer S (API)", () => p.signUp({ prefix: "e6sc_s" }));
  const channel = s.me.channelSlug ?? s.username;
  ctx.data("users", { s: s.username });

  const list = async (): Promise<SimulcastTarget[]> => {
    const r = await s.api.client.stream.simulcast.list({ channel });
    responses.push(r);
    return r;
  };

  // ------------------------------------------------------------ 1. add the target
  let session: WebSession | null = null;
  const name = `mock ${ctx.runId}`.slice(0, 40);
  let targetId: string;
  const browserRpc = new RpcResponses();
  if (kit.via === "web") {
    session = await kit.webSession("S", s);
    browserRpc.attach(await session.page());
    const sess = session;
    targetId = await ctx.step("1 S adds the mock target on /dashboard", async () => {
      const page = await sess.goto(E6_ROUTES.dashboard);
      const section = byE6Id(page, E.simulcast);
      await section.waitFor({ timeout: UI_TIMEOUT_MS });
      await byE6Id(section, E.simulcastName).fill(name, { timeout: UI_TIMEOUT_MS });
      await chooseOption(page, section, E.simulcastPlatform, "custom", UI_TIMEOUT_MS);
      await byE6Id(section, E.simulcastUrl).fill(targetUrl, { timeout: UI_TIMEOUT_MS });
      await byE6Id(section, E.simulcastKey).fill(key, { timeout: UI_TIMEOUT_MS });
      await byE6Id(section, E.simulcastAdd).click({ timeout: UI_TIMEOUT_MS });
      const row = byE6Id(section, E.simulcastTarget, { enabled: "true" });
      const data = await dataOf(row, UI_TIMEOUT_MS);
      if (!data.targetId) throw new Error("simulcast-target has no data-target-id");
      // The list never shows the key: not as text, not in an attribute.
      const html = await byE6Id(section, E.simulcastTarget).evaluateAll((els) => els.map((e) => e.outerHTML).join(""));
      ctx.assert("1 the target list on /dashboard does not show the key", !html.includes(key));
      const keyInputType = await byE6Id(section, E.simulcastKey).getAttribute("type");
      ctx.check("1 the key field is a password input", keyInputType === "password", { type: keyInputType });
      return data.targetId;
    });
  } else {
    targetId = await ctx.step("1 S adds the mock target (API)", async () => {
      const t = await s.api.client.stream.simulcast.create({
        channel,
        platform: "custom",
        name,
        rtmpUrl: targetUrl,
        streamKey: key,
        enabled: true,
      });
      responses.push(t);
      return t.id;
    });
  }
  ctx.data("targetId", targetId);
  const targets = await ctx.step("1 stream.simulcast.list has the target, enabled", () => list());
  const target = targets.find((t) => t.id === targetId);
  ctx.assert("1 the target is listed and enabled", target?.enabled === true, { listed: target !== undefined });
  ctx.assert(
    "1 the list response has no key field",
    targets.every((t) => keyFields(t).length === 0),
    {
      fields: targets.flatMap(keyFields),
    },
  );
  ctx.assert("1 the list response does not contain the key", !JSON.stringify(targets).includes(key));

  const status = async (): Promise<string | null> => (await list()).find((t) => t.id === targetId)?.status ?? null;
  /** The dashboard row's `data-status` (reloading, in case the page does not poll). */
  const waitStatus = async (want: string, timeoutMs: number): Promise<number> => {
    const started = Date.now();
    if (session) {
      // The section polls the list every 5 s itself; reloading the page instead would trip the
      // session check's rate limit and render the dashboard signed out.
      const page = await session.goto(E6_ROUTES.dashboard);
      await waitFor(
        `simulcast-target data-status="${want}"`,
        async () => {
          const row = byE6Id(page, E.simulcastTarget, { "target-id": targetId });
          return (await row.count()) > 0 && (await row.first().getAttribute("data-status")) === want ? true : null;
        },
        { timeoutMs, intervalMs: 1_000, signal: ctx.signal },
      );
    } else {
      await waitFor(`target status ${want}`, async () => ((await status()) === want ? true : null), {
        timeoutMs,
        intervalMs: 1_000,
        signal: ctx.signal,
      });
    }
    return Date.now() - started;
  };

  // ------------------------------------------------------------ 2. go live
  const streamer = await ctx.step("2 rotate S's stream key", () => p.streamerFor(s, { protocol: "rtmp" }));
  ctx.defer(() => streamer.stop());
  await ctx.step("2 S goes live (ffmpeg test pattern)", () => streamer.start());
  await ctx.step("2 the channel is live", () => p.waitForLive(channel, true, 30_000));
  const toLive = await ctx.step("2 the target reports live", () => waitStatus("live", STATUS_DEADLINE_MS + SLACK_MS));
  ctx.metric("simulcast_status_live_ms", toLive, "ms");
  ctx.check(`2 the target is live within ${STATUS_DEADLINE_MS / 1000} s`, toLive <= STATUS_DEADLINE_MS, { toLive });

  // ------------------------------------------------------------ 3. frames arrive
  const probe = await ctx.step("3 ffprobe counts frames at the mock target", () =>
    waitFor(
      `${MIN_FRAMES} frames at the mock target`,
      async () => {
        const r = await probeFrames(readUrl, FRAME_WINDOW_S);
        return r.frames >= MIN_FRAMES ? r : null;
      },
      { timeoutMs: 45_000, intervalMs: 1_000, signal: ctx.signal },
    ),
  );
  ctx.metric("simulcast_frames_in_10s", probe.frames);
  ctx.assert(`3 frames arrived (≥ ${MIN_FRAMES} in ${FRAME_WINDOW_S} s)`, probe.frames >= MIN_FRAMES, {
    frames: probe.frames,
  });
  ctx.assert(
    "3 the frames have the source resolution",
    probe.width === STREAMER_DEFAULTS.width && probe.height === STREAMER_DEFAULTS.height,
    { width: probe.width, height: probe.height },
  );

  // ------------------------------------------------------------ 4. disable, re-enable
  const setEnabled = async (enabled: boolean) => {
    if (session) {
      const page = await session.goto(E6_ROUTES.dashboard);
      const row = byE6Id(page, E.simulcastTarget, { "target-id": targetId });
      await setSwitch(byE6Id(row, E.simulcastEnabled), enabled, UI_TIMEOUT_MS);
      await byE6Id(page, E.simulcastTarget, { "target-id": targetId, enabled: String(enabled) }).waitFor({
        timeout: UI_TIMEOUT_MS,
      });
    } else {
      responses.push(await s.api.client.stream.simulcast.update({ channel, id: targetId, enabled }));
    }
  };
  const disabledAt = await ctx.step("4 S disables the target", async () => {
    await setEnabled(false);
    return Date.now();
  });
  const stopProbes: FrameProbe[] = [];
  await ctx.step("4 the mock path has no publisher and the status is idle", () =>
    waitFor(
      "no publisher at the mock target and status idle",
      async () => {
        stopProbes.push(await probeFrames(readUrl, NO_PUBLISHER_PROBE_S));
        return pushStopped(stopProbes) && (await status()) === "idle" ? true : null;
      },
      {
        timeoutMs: STATUS_DEADLINE_MS + SLACK_MS + 2 * NO_PUBLISHER_PROBE_S * 1000,
        intervalMs: 500,
        signal: ctx.signal,
      },
    ),
  );
  const toStopped = Date.now() - disabledAt;
  ctx.metric("simulcast_disable_effect_ms", toStopped, "ms");
  ctx.check(`4 the push stopped within ${STATUS_DEADLINE_MS / 1000} s`, toStopped <= STATUS_DEADLINE_MS + 2_000, {
    toStopped,
  });
  const enabledAt = await ctx.step("4 S re-enables the target", async () => {
    await setEnabled(true);
    return Date.now();
  });
  await ctx.step("4 frames arrive again", () =>
    waitFor("frames at the mock target again", async () => ((await probeFrames(readUrl, 3)).frames > 0 ? true : null), {
      timeoutMs: STATUS_DEADLINE_MS + SLACK_MS,
      intervalMs: 1_000,
      signal: ctx.signal,
    }),
  );
  const toRestarted = Date.now() - enabledAt;
  ctx.metric("simulcast_enable_effect_ms", toRestarted, "ms");
  ctx.check(`4 frames again within ${RESTART_DEADLINE_MS / 1000} s`, toRestarted <= RESTART_DEADLINE_MS, {
    toRestarted,
  });

  // ------------------------------------------------------------ 5. offline
  await ctx.step("5 S goes offline", async () => {
    await streamer.stop();
    await p.waitForLive(channel, false, 60_000);
  });
  const sessions = await ctx.step("5 simulcast_sessions: ended, bytes sent (DB)", () =>
    waitFor(
      "every simulcast session of the target ended",
      async () => {
        const rows = await simulcastSessions(kit.databaseUrl, targetId);
        return rows.length > 0 && rows.every((r) => r.endedAt !== null) ? rows : null;
      },
      { timeoutMs: 60_000, intervalMs: 1_000, signal: ctx.signal },
    ),
  );
  ctx.data(
    "simulcastSessions",
    sessions.map((r) => ({ status: r.status, bytesSent: r.bytesSent, ended: r.endedAt !== null })),
  );
  ctx.assert(
    "5 a simulcast session has bytes_sent > 0 and an end time",
    sessions.some((r) => r.bytesSent > 0 && r.endedAt !== null),
  );

  await removeTarget(ctx, s, channel, targetId, session, responses);
  const browser = await browserRpc.settle(15_000, ctx.signal);
  if (session) {
    ctx.data("browserRpcResponses", browser.bodies.length);
    if (browser.unfinished > 0) ctx.log.warn("browser /rpc bodies never finished", { unfinished: browser.unfinished });
  }
  await scanForKey(ctx, kit, key, startedAt, [...responses, ...browser.bodies]);
}

async function removeTarget(
  ctx: ScenarioContext,
  s: SignedInUser,
  channel: string,
  targetId: string,
  session: WebSession | null,
  responses: unknown[],
): Promise<void> {
  await ctx.step("S removes the target", async () => {
    if (session) {
      // Twice on slow CI runners this step hung until the scenario timeout with the target already
      // gone from the page. Each action is logged and the web path is capped, so a stuck browser
      // call names itself and the list below still decides.
      let at = "open /dashboard";
      const web = (async () => {
        const page = await session.goto(E6_ROUTES.dashboard);
        const row = byE6Id(page, E.simulcastTarget, { "target-id": targetId });
        at = "click remove";
        await byE6Id(row, E.simulcastRemove).click({ timeout: UI_TIMEOUT_MS });
        at = "confirm";
        await confirmDialog(page, UI_TIMEOUT_MS);
        at = "row detached";
        await row.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
        at = "done";
      })();
      const capped = await Promise.race([web.then(() => false), sleep(WEB_REMOVE_CAP_MS, ctx.signal).then(() => true)]);
      if (capped) {
        web.catch(() => undefined);
        ctx.log.warn("simulcast web removal still running past its cap", { at, capMs: WEB_REMOVE_CAP_MS });
        ctx.data("simulcast.webRemoveStuckAt", at);
      }
    } else {
      await s.api.client.stream.simulcast.remove({ channel, id: targetId });
    }
    const left = await s.api.client.stream.simulcast.list({ channel });
    responses.push(left);
    ctx.check("the target is gone from the list", !left.some((t) => t.id === targetId));
  });
}

/** Longest the web removal may take before the step logs where it stuck and lets the list decide. */
const WEB_REMOVE_CAP_MS = 60_000;
async function scanForKey(
  ctx: ScenarioContext,
  kit: Kit,
  key: string,
  since: Date,
  responses: unknown[],
): Promise<void> {
  const text = (r: unknown) => (typeof r === "string" ? r : JSON.stringify(r));
  ctx.assert("5 no API response of the run contains the key", !responses.some((r) => text(r).includes(key)), {
    responses: responses.length,
  });
  const inEvents = await ctx.step("5 scan the outbox events of the run for the key (DB)", () =>
    eventsContaining(kit.databaseUrl, key, since),
  );
  ctx.assert("5 no outbox event of the run contains the key", inEvents === 0, { events: inEvents });
  const needles = textNeedles("simulcast-key", [key]);
  const containers = await ctx.step("5 find the services' containers", () =>
    serviceContainers(ctx.env.HARNESS_CONTAINER_PREFIX),
  );
  ctx.assert("5 service containers found (podman)", containers.length > 0, {
    prefix: ctx.env.HARNESS_CONTAINER_PREFIX,
  });
  const hits = await ctx.step("5 scan the services' logs for the key", async () => {
    const all = [];
    for (const c of containers) all.push(...scanLog(c.service, await containerLogs(c.name, since), needles));
    return all;
  });
  ctx.data("logScan", { services: [...new Set(containers.map((c) => c.service))], hits: summarizeHits(hits) });
  ctx.assert("5 no service log line of the run contains the key", hits.length === 0, summarizeHits(hits));
}
