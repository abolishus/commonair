// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Three honest viewers and a viewbot swarm that never downloads media (headless fingerprints,
 * periodic heartbeats, playlist polling, few devices) on one channel. The worker's integrity
 * scorer must exclude every bot with reasons while the honest viewers verify: the public viewer
 * count converges to exactly 3 and never counts a bot.
 *
 * Parameters: `--set bots=12 --set browserViewers=1 --set convergeSeconds=150`.
 *
 * The per-session reasons are read from Postgres when `DATABASE_URL` is set (the harness host
 * can reach the stack's database in development); the public API exposes only counts.
 */
import { defineScenario } from "../src/scenario.ts";
import { ViewbotSwarm } from "../src/viewbot.ts";
import { waitFor } from "../src/wait.ts";

const HONEST = 3;

interface SessionRow {
  id: string;
  verdict: string;
  verdict_reasons: string[] | null;
  flags: number;
}

export default defineScenario({
  name: "integrity-basic",
  description: "3 honest viewers + a fetch-less viewbot swarm; count converges to 3, bots excluded with reasons",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const bots = ctx.intParam("bots", 12);
    const browsers = Math.min(HONEST, ctx.intParam("browserViewers", 1));
    const convergeMs = ctx.intParam("convergeSeconds", 150) * 1000;

    const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: "integ" }));
    const channel = streamer.me.channelSlug ?? streamer.username;
    const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 854, height: 480, bitrateKbps: 1500 });
    ctx.defer(() => s.stop());
    await ctx.step("publish", () => s.start());
    await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));

    const honest = await ctx.step(`open ${HONEST} honest viewers`, () =>
      p.openViewers(channel, { chromium: browsers, http: HONEST - browsers }),
    );
    for (const v of honest) ctx.defer(() => v.stop());
    const swarm = new ViewbotSwarm({ channel, sessions: bots }, p.datacenter, (o) => p.api(o), p.log);
    ctx.defer(() => swarm.stop());
    await ctx.step(`start ${bots} viewbots`, () => swarm.start());

    const firstFrames = await ctx.step("honest first frames", () =>
      Promise.allSettled(honest.map((v) => v.waitForFirstFrame(60_000))),
    );
    const started = firstFrames.filter((r) => r.status === "fulfilled").length;
    ctx.assert("every honest viewer started playback", started === HONEST, { started });
    ctx.assert("every bot opened a session", swarm.sessionIds.length === bots, { sessions: swarm.sessionIds.length });

    let maxSeen = 0;
    let last = { verified: 0, pending: 0, excluded: 0 };
    const converged = await ctx.step(`count converges to ${HONEST} with the bots excluded`, async () => {
      const t0 = Date.now();
      await waitFor(
        `count ${HONEST}, ${bots} excluded`,
        async () => {
          const count = (await p.viewerCount(channel)) ?? 0;
          maxSeen = Math.max(maxSeen, count);
          last = (await streamer.api.client.stream.health({ channel })).viewers;
          return count === HONEST && last.excluded >= bots;
        },
        { timeoutMs: convergeMs, intervalMs: 2_000, signal: ctx.signal },
      );
      return Date.now() - t0;
    });
    ctx.metric("viewer_count.converge", converged, "ms");
    ctx.metric("sessions.excluded", last.excluded);
    ctx.check("public count never counted a bot", maxSeen <= HONEST, { maxSeen });

    // Stable: several more scoring runs (every 15 s) must not let a bot back in or drop an
    // honest viewer. Every simulated client shares one address unless the API trusts the
    // harness proxy, so a rate-limited read is retried rather than failing the run.
    await ctx.step("count stays at 3", async () => {
      const samples: number[] = [];
      for (let i = 0; i < 8; i++) {
        await Bun.sleep(5_000);
        const { count } = await waitFor(
          "viewer count read",
          () => p.viewerCount(channel).then((c) => ({ count: c ?? 0 })),
          { timeoutMs: 20_000, intervalMs: 2_000, signal: ctx.signal },
        );
        samples.push(count);
      }
      maxSeen = Math.max(maxSeen, ...samples);
      ctx.assert(
        `count stays at ${HONEST} for 40 s`,
        samples.every((c) => c === HONEST),
        { samples },
      );
    });

    const url = process.env.DATABASE_URL;
    if (url) {
      const rows = await ctx.step("bot verdicts and reasons", async () => {
        const sql = new Bun.SQL(url);
        try {
          return (await sql`
            select p.id, p.verdict::text as verdict, p.verdict_reasons,
                   (select count(*)::int from integrity_flags f
                     where f.subject_type = 'session' and f.subject_id = p.id) as flags
              from playback_sessions p
             where p.id = any(${sql.array(swarm.sessionIds, "uuid")})`) as SessionRow[];
        } finally {
          await sql.close();
        }
      });
      // Zero (or too few) rows would make the checks below pass vacuously.
      ctx.assert(
        "every bot session is in Postgres (DATABASE_URL does not point at the stack under test?)",
        rows.length === bots,
        { found: rows.length, bots },
      );
      const excluded = rows.filter((r) => r.verdict === "excluded");
      ctx.assert("every bot session is excluded", excluded.length === bots, {
        verdicts: rows.map((r) => r.verdict),
      });
      ctx.assert(
        "every exclusion has reasons and flags",
        excluded.every((r) => (r.verdict_reasons?.length ?? 0) > 0 && r.flags > 0),
        rows.slice(0, 3),
      );
      const reasons = [...new Set(rows.flatMap((r) => r.verdict_reasons ?? []))].sort();
      ctx.data("bot.reasons", reasons);
      ctx.check("fetch evidence is among the reasons", reasons.includes("fetch_pattern"), { reasons });
    } else {
      ctx.log.warn("DATABASE_URL not set: per-session reasons not checked (counts only)");
    }

    await ctx.step("stop", () => Promise.all([swarm.stop(), ...honest.map((v) => v.stop())]));
  },
});
