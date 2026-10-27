// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N well-behaved viewers on one channel; the public (verified) viewer count must converge to
 * exactly N and never overshoot it. Parameters: `--set viewers=10 --set browserViewers=2
 * --set convergeSeconds=120`.
 *
 * P2P (P1, ADR 0005 amendment 1): `--set p2p=<n>` adds n web Chromium viewers that opted in to
 * P2P and `--set p2pDefault=<n>` (default 1 when p2p > 0) web Chromium viewers left at the
 * operator default, which the stack keeps `off`. `p2p` defaults to 0 until P1-player merges. With
 * p2p > 0 the run also asserts that P2P carried bytes, digests were served and none rejected,
 * opted-in sessions fetched less over HTTP than the default viewers, verdicts are unchanged and
 * the default viewers never touched a peer. Needs `DATABASE_URL`, Valkey from the repo `.env`, the
 * harness stack (harness/compose.p2p.yaml) and, for the digest checks, HARNESS_PROMETHEUS_URL.
 */
import { KEYS } from "@commonair/contracts/internal";
import { RedisClient } from "bun";
import { viewerP2PStatus } from "../src/browser-viewer.ts";
import { ORIGIN_EGRESS_QUERY, P2P_DIGEST_SERVED_QUERY, P2P_REJECTED_QUERY, Prometheus } from "../src/metrics.ts";
import { valkeyUrl } from "../src/multi/replicas.ts";
import {
  egressDropped,
  httpBytesPerSecond,
  P2P_EGRESS_MARGIN,
  p2pViewerParams,
  type SessionStats,
  unverified,
} from "../src/p2p.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { aggregateReports, type Viewer } from "../src/viewer.ts";
import { waitFor } from "../src/wait.ts";

export default defineScenario({
  name: "viewers",
  description: "N viewers on one channel; verified viewer count converges to N",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const plain = ctx.intParam("viewers", 10);
    const browsers = Math.min(plain, ctx.intParam("browserViewers", 2));
    const convergeMs = ctx.intParam("convergeSeconds", 120) * 1000;
    const p2p = p2pViewerParams((name, fallback) => ctx.intParam(name, fallback));
    const total = plain + p2p.optedIn + p2p.atDefault;
    ctx.data("p2p", p2p);

    if (p2p.optedIn + p2p.atDefault > 0) {
      const info = await ctx.step("instance info", () => p.api().client.instance.info());
      ctx.assert("the stack runs with P2P_DEFAULT=off", info.features.p2pDefault === "off", info.features);
      if (p2p.optedIn > 0) {
        ctx.assert("P2P is enabled on the stack", info.features.p2p, info.features);
        ctx.assert("DATABASE_URL is set (the database is the record of P2P bytes)", Boolean(process.env.DATABASE_URL));
      }
    }

    const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: "viewers" }));
    const channel = streamer.me.channelSlug ?? streamer.username;
    const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 854, height: 480, bitrateKbps: 1500 });
    ctx.defer(() => s.stop());
    await ctx.step("publish", () => s.start());
    await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));

    const startedAt = Date.now();
    const viewers = await ctx.step(`open ${total} viewers`, () =>
      p.openViewers(channel, {
        chromium: Math.ceil(browsers / 2),
        webkit: Math.floor(browsers / 2),
        http: plain - browsers,
        ...(p2p.optedIn + p2p.atDefault > 0 ? { p2p } : {}),
      }),
    );
    for (const v of viewers) ctx.defer(() => v.stop());
    // openViewers appends P2P viewers after the browser viewers and before the HTTP ones.
    const firstP2P = Math.ceil(browsers / 2) + Math.floor(browsers / 2);
    const optedIn = viewers.slice(firstP2P, firstP2P + p2p.optedIn);
    const atDefault = viewers.slice(firstP2P + p2p.optedIn, firstP2P + p2p.optedIn + p2p.atDefault);

    const firstFrames = await ctx.step("first frames", () =>
      Promise.allSettled(viewers.map((v) => v.waitForFirstFrame(60_000))),
    );
    const started = firstFrames.filter((r) => r.status === "fulfilled").length;
    ctx.metric("viewers.started", started);
    ctx.assert("every viewer started playback", started === total, { started, total });

    let maxSeen = 0;
    const converged = await ctx.step(`verified count converges to ${total}`, async () => {
      const t0 = Date.now();
      await waitFor(
        `viewer count ${total}`,
        async () => {
          const count = (await p.viewerCount(channel)) ?? 0;
          maxSeen = Math.max(maxSeen, count);
          return count === total;
        },
        { timeoutMs: convergeMs, intervalMs: 2_000, signal: ctx.signal },
      );
      return Date.now() - t0;
    });
    ctx.metric("viewer_count.converge", converged, "ms");
    ctx.check("count never exceeded the real audience", maxSeen <= total, { maxSeen, total });

    // The player's data-p2p attribute is a hard requirement only when P2P viewers opted in,
    // i.e. once P1-player has landed; default-only runs check it softly.
    if (atDefault.length > 0) await checkDefaultViewersStayedOff(ctx, atDefault, p2p.optedIn > 0);

    const reports = await ctx.step("stop viewers", () => Promise.all(viewers.map((v) => v.stop())));
    const agg = aggregateReports(reports);
    ctx.metric("ttff.p95", agg.ttff.p95, "ms");
    ctx.metric("stall.ratio", agg.stallRatio);
    ctx.check("stall ratio below 5 %", agg.stallRatio < 0.05, { stallRatio: agg.stallRatio });

    if (p2p.optedIn > 0) {
      const ids = (vs: Viewer[]) =>
        vs.map((v) => reports[viewers.indexOf(v)]?.sessionId).filter((id): id is string => Boolean(id));
      const p2pViewers = new Set([...optedIn, ...atDefault]);
      await checkP2PRecord(ctx, {
        optedIn: ids(optedIn),
        atDefault: ids(atDefault),
        http: ids(viewers.filter((v) => !p2pViewers.has(v))),
      });
      await checkP2PMetrics(ctx, (Date.now() - startedAt) / 1000);
    }

    // Stale sessions drop out of the count once their heartbeats stop (30 s window).
    const decayed = await ctx
      .step("count decays after viewers leave", () =>
        waitFor("viewer count 0", async () => ((await p.viewerCount(channel)) ?? 0) === 0, {
          timeoutMs: 75_000,
          intervalMs: 3_000,
          signal: ctx.signal,
        }),
      )
      .then(() => true)
      .catch(() => false);
    ctx.check("count returns to zero after viewers leave", decayed);
  },
});

/** A viewer at the default (off) never connected to a peer and holds no grant or tracker record. */
async function checkDefaultViewersStayedOff(
  ctx: ScenarioContext,
  atDefault: Viewer[],
  strictPlayerState: boolean,
): Promise<void> {
  const seen = await ctx.step("default viewers stayed off P2P", async () => {
    const valkey = new RedisClient(valkeyUrl(process.env));
    await valkey.connect();
    try {
      return await Promise.all(
        atDefault.map(async (v) => {
          const sid = (await v.report()).sessionId;
          return {
            sid,
            status: await viewerP2PStatus(v),
            grant: sid ? await valkey.exists(KEYS.p2pGrant(sid)) : null,
            peer: sid ? await valkey.exists(KEYS.p2pPeer(sid)) : null,
          };
        }),
      );
    } finally {
      valkey.close();
    }
  });
  ctx.assert(
    "default viewers made no peer connection",
    seen.every((r) => r.status !== null && r.status.peerConnections === 0),
    seen,
  );
  const showOff = seen.every((r) => r.status?.state === "off");
  if (strictPlayerState) ctx.assert("default viewers show data-p2p=off", showOff, seen);
  else ctx.check("default viewers show data-p2p=off", showOff, seen);
  ctx.assert(
    "default viewers hold no P2P grant and no tracker record",
    seen.every((r) => r.sid !== null && r.grant === false && r.peer === false),
    seen,
  );
}

/** What Postgres recorded, after the integrity scorer has seen every session. */
async function checkP2PRecord(
  ctx: ScenarioContext,
  ids: { optedIn: string[]; atDefault: string[]; http: string[] },
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const all = [...ids.optedIn, ...ids.atDefault, ...ids.http];
  const sql = new Bun.SQL(url);
  try {
    const rows = await ctx.step("sessions scored", async () => {
      let last: SessionStats[] = [];
      await waitFor(
        "every session scored",
        async () => {
          last = (await sql`
            select id, bytes_http::float8 as bytes_http, bytes_p2p::float8 as bytes_p2p, watch_seconds,
                   verdict::text as verdict, verdict_reasons, scored_at is not null as scored
              from playback_sessions where id = any(${sql.array(all, "uuid")})`) as (SessionStats & {
            scored: boolean;
          })[];
          return last.length === all.length && last.every((r) => (r as { scored?: boolean }).scored);
        },
        { timeoutMs: 180_000, intervalMs: 5_000, signal: ctx.signal },
      );
      return last;
    });
    const pick = (list: string[]) => rows.filter((r) => list.includes(r.id));
    const opted = pick(ids.optedIn);
    const bytesP2p = opted.reduce((s, r) => s + Number(r.bytes_p2p), 0);
    ctx.metric("p2p.bytes", bytesP2p, "By");
    ctx.assert("opted-in sessions received bytes from peers", bytesP2p > 0, { bytesP2p });

    const optedRate = httpBytesPerSecond(opted);
    const baseline = httpBytesPerSecond(pick(ids.atDefault));
    ctx.metric("p2p.http_bytes_per_second", optedRate, "By/s");
    ctx.metric("p2p.baseline_http_bytes_per_second", baseline, "By/s");
    ctx.check(
      `opted-in sessions fetch at least ${P2P_EGRESS_MARGIN * 100} % less over HTTP than default viewers`,
      egressDropped(optedRate, baseline),
      { optedRate, baseline, margin: P2P_EGRESS_MARGIN },
    );

    const bad = unverified(rows);
    ctx.assert("every session is verified, none with a fetch reason (P2P changes no verdict)", bad.length === 0, bad);
  } finally {
    await sql.close();
  }
}

/** Digests checked: the origin served some and players rejected none; egress recorded as a metric. */
async function checkP2PMetrics(ctx: ScenarioContext, windowSeconds: number): Promise<void> {
  const base = ctx.env.HARNESS_PROMETHEUS_URL;
  if (!base) {
    ctx.skipStep("P2P digest metrics", "HARNESS_PROMETHEUS_URL is not set");
    return;
  }
  const prom = new Prometheus(base);
  // The collector exports on an interval: give the last increments time to arrive.
  await Bun.sleep(15_000);
  const scalar = async (q: string) => (await prom.query(q))?.[0]?.value ?? null;
  const served = await scalar(P2P_DIGEST_SERVED_QUERY(windowSeconds));
  const rejected = await scalar(P2P_REJECTED_QUERY(windowSeconds));
  const egress = (await prom.query(ORIGIN_EGRESS_QUERY(windowSeconds))) ?? [];
  ctx.metric("p2p.digests_served", served);
  ctx.metric("p2p.rejected", rejected);
  ctx.metric(
    "origin.egress.bytes",
    egress.reduce((s, r) => s + r.value, 0),
    "By",
  );
  ctx.assert("the origin served P2P digests", (served ?? 0) > 0, { served });
  ctx.assert("no peer-delivered segment failed digest validation", (rejected ?? 0) === 0, { rejected });
}
