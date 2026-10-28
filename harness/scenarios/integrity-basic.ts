// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Honest viewers and three kinds of bot on one channel. The worker's integrity scorer must:
 *
 * - exclude every datacenter viewbot (headless fingerprints, periodic heartbeats, playlist
 *   polling, few devices) with reasons;
 * - never verify a fetch-less bot: plausible fingerprints from residential addresses that
 *   heartbeat claimed playback and request no playlist or media at all (pending with
 *   `media_unconfirmed`, or excluded on `fetch_pattern`);
 * - verify honest viewers that look unusual: a household of viewers behind one address, and a
 *   viewer whose tab is hidden for a while (background heartbeat cadence, `visible: false`);
 * - (CDN step) mark a session assigned to the CDN that never pulls anything `fetch_unjudged`: it
 *   may verify, but it is not gate-eligible and its hour does not count toward stream-hour
 *   eligibility.
 *
 * The public viewer count converges to exactly the honest audience and never counts a bot.
 *
 * Parameters: `--set bots=12 --set browserViewers=1 --set convergeSeconds=150 --set fetchless=3
 * --set household=3 --set hiddenSeconds=45 --set cdnAttempts=3`.
 *
 * The per-session reasons are read from Postgres when `DATABASE_URL` is set (the harness host
 * can reach the stack's database in development); the public API exposes only counts.
 *
 * The CDN step runs when the CDN adapter is configured (`CDN_PROVIDER=origin-pull`,
 * `CDN_BASE_URL`; skipped under `--profile no-proprietary`). The API sends a session to the CDN
 * only while the channel's verified viewers exceed `CDN_BURST_VIEWER_THRESHOLD`, so the stack needs
 * that threshold one below the honest audience: 6 with the defaults (household + hidden tab + 3).
 * Every other session starts together before anyone is verified and the scenario fails if one of
 * them lands on the CDN anyway; with a higher threshold the CDN step is skipped with that reason.
 * Its stream-hour check runs the stream-hours pass through the co-op test hook
 * (`harness/compose.e5-coop.yaml`, `COOP_TEST_HOOKS=true`) and is skipped without it.
 */
import { CoopHooks, CoopHooksOff } from "../src/coop-io.ts";
import { HttpViewer } from "../src/http-viewer.ts";
import {
  HeartbeatOnlyViewer,
  HiddenTabViewer,
  cdnBotSettled,
  fetchlessHeld,
  gateEligible,
  honestAudience,
  onCdn,
  type Placement,
  STEADY_TIMING,
} from "../src/integrity-viewers.ts";
import { internalSecret } from "../src/safety-io.ts";
import { defineScenario, excludedNeeds } from "../src/scenario.ts";
import type { Viewer } from "../src/viewer.ts";
import { ViewbotSwarm } from "../src/viewbot.ts";
import { waitFor } from "../src/wait.ts";

/** Ordinary honest viewers (browser and HTTP). */
const PLAIN = 3;

interface SessionRow {
  id: string;
  verdict: string;
  verdict_reasons: string[] | null;
  flags: number;
}

async function sessionRows(url: string, ids: readonly string[]): Promise<SessionRow[]> {
  if (ids.length === 0) return [];
  const sql = new Bun.SQL(url);
  try {
    return (await sql`
      select p.id, p.verdict::text as verdict, p.verdict_reasons,
             (select count(*)::int from integrity_flags f
               where f.subject_type = 'session' and f.subject_id = p.id) as flags
        from playback_sessions p
       where p.id = any(${sql.array([...ids], "uuid")})`) as SessionRow[];
  } finally {
    await sql.close();
  }
}

/**
 * Seconds since each session's last heartbeat as Postgres has it, with its verdict: on a dip, says
 * which honest viewer went quiet (or changed verdict).
 */
async function heartbeatAges(
  url: string,
  ids: ReadonlyMap<string, string>,
): Promise<{ viewer: string; ageS: number | null; verdict: string }[]> {
  if (ids.size === 0) return [];
  const sql = new Bun.SQL(url);
  try {
    const rows = (await sql`
      select id, verdict::text as verdict,
             extract(epoch from (now() - last_heartbeat_at))::float8 as age
        from playback_sessions where id = any(${sql.array([...ids.keys()], "uuid")})`) as {
      id: string;
      verdict: string;
      age: number | null;
    }[];
    return rows.map((r) => ({
      viewer: ids.get(r.id) ?? r.id,
      ageS: r.age === null ? null : Math.round(r.age * 10) / 10,
      verdict: r.verdict,
    }));
  } finally {
    await sql.close();
  }
}

interface HourCounts {
  hour_start: Date;
  /** `stream_hours.verified_other_viewers` as the job wrote it. */
  n: number;
  /** Viewers counted under the job's rule (`GATE_ELIGIBLE`), recomputed here. */
  gate: number;
  /** The same without the fetch-judged condition (verified and scored only). */
  scored: number;
  /** 1 when the bot's session passes everything but the fetch-judged condition. */
  botCandidate: number;
}

/**
 * The latest hour of the bot's broadcast, recounted with the stream-hours rule of
 * `markEligibleStreamHours` (packages/integrity/src/jobs.ts) twice: with `GATE_ELIGIBLE` and
 * with only its verified-and-scored part. Mirrors that query; keep the two in step.
 */
async function hourCounts(url: string, botSession: string): Promise<HourCounts | null> {
  const sql = new Bun.SQL(url);
  try {
    const [r] = (await sql`
      with h as (
        select sh.broadcast_id, sh.hour_start, sh.channel_id, c.owner_id, sh.verified_other_viewers as n
          from stream_hours sh join channels c on c.id = sh.channel_id
         where sh.broadcast_id = (select broadcast_id from playback_sessions where id = ${botSession}::uuid)
         order by sh.hour_start desc limit 1
      ),
      cand as (
        select coalesce(ps.user_id::text, 'device:' || ps.device_hash) as who,
               not ('fetch_unjudged' = any(coalesce(ps.verdict_reasons, '{}'))) as judged,
               ps.id = ${botSession}::uuid as is_bot
          from h join playback_sessions ps
            on ps.channel_id = h.channel_id and ps.verdict = 'verified' and ps.scored_at is not null
           and ps.started_at < h.hour_start + interval '1 hour'
           and coalesce(ps.ended_at, ps.last_heartbeat_at, ps.started_at) > h.hour_start
         where ps.user_id is distinct from h.owner_id
           and not exists (select 1 from playback_sessions od
                            where od.user_id = h.owner_id and od.device_hash = ps.device_hash
                              and od.started_at >= now() - interval '32 days')
           and not exists (select 1 from playback_sessions o
                            where o.user_id = h.owner_id and o.ip_hash = ps.ip_hash
                              and o.started_at < h.hour_start + interval '2 hours'
                              and coalesce(o.ended_at, o.last_heartbeat_at, o.started_at)
                                  > h.hour_start - interval '1 hour')
           and not exists (select 1 from stream_keys sk join broadcasts b on b.id = h.broadcast_id
                            where sk.channel_id = h.channel_id and sk.last_used_ip_hash = ps.ip_hash
                              and sk.last_used_at >= b.started_at - interval '10 minutes'
                              and sk.last_used_at <= coalesce(b.ended_at, now()))
      )
      select h.hour_start, h.n::int as n,
             (select count(distinct who) from cand where judged)::int as gate,
             (select count(distinct who) from cand)::int as scored,
             (select count(*) from cand where is_bot)::int as "botCandidate"
        from h`) as HourCounts[];
    return r ?? null;
  } finally {
    await sql.close();
  }
}

const row = (r: SessionRow) => ({ verdict: r.verdict, reasons: r.verdict_reasons });

export default defineScenario({
  name: "integrity-basic",
  description:
    "honest (incl. a household and a hidden tab) + datacenter, fetch-less and CDN bots; count converges to the honest audience",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const bots = ctx.intParam("bots", 12);
    const browsers = Math.min(PLAIN, ctx.intParam("browserViewers", 1));
    const convergeMs = ctx.intParam("convergeSeconds", 150) * 1000;
    const fetchlessCount = Math.max(0, ctx.intParam("fetchless", 3));
    const householdCount = Math.max(0, ctx.intParam("household", 3));
    const hiddenMs = Math.max(0, ctx.intParam("hiddenSeconds", 45)) * 1000;
    const cdnAttempts = Math.max(1, ctx.intParam("cdnAttempts", 3));
    const expected = honestAudience({ plain: PLAIN, household: householdCount, hidden: 1 });

    const streamer = await ctx.step("sign up streamer", () => p.signUp({ prefix: "integ" }));
    const channel = streamer.me.channelSlug ?? streamer.username;
    const s = await p.streamerFor(streamer, { protocol: "rtmp", width: 854, height: 480, bitrateKbps: 1500 });
    ctx.defer(() => s.stop());
    await ctx.step("publish", () => s.start());
    await ctx.step("channel goes live", () => p.waitForLive(channel, true, 30_000));

    // Every session of the origin cases starts at once, before any viewer can be verified (about
    // three beats, 30 s): the API sends a session to a burst CDN only once the channel's verified
    // viewers exceed CDN_BURST_VIEWER_THRESHOLD, so none of these can land there. Checked below.
    const householdIp = p.residential.next();
    const household = Array.from(
      { length: householdCount },
      (_, i) =>
        new HttpViewer({
          id: `household-${i}`,
          target: { channel },
          api: p.api({ clientIp: householdIp }).client,
          timing: STEADY_TIMING,
          log: p.log,
        }),
    );
    const hidden = new HiddenTabViewer({ id: "hidden-tab", api: p.api().client, channel, log: p.log });
    const swarm = new ViewbotSwarm({ channel, sessions: bots }, p.datacenter, (o) => p.api(o), p.log);
    // Each fetch-less bot its own address (p.api picks a fresh residential one) and device.
    const fetchless = Array.from(
      { length: fetchlessCount },
      (_, i) => new HeartbeatOnlyViewer({ id: `fetchless-${i}`, api: p.api().client, channel, log: p.log }),
    );
    for (const v of [...household, hidden, swarm, ...fetchless]) ctx.defer(() => v.stop());
    const [plain] = await ctx.step(
      `open ${PLAIN} honest viewers, a household of ${householdCount}, a hidden tab, ${bots} viewbots and ${fetchlessCount} fetch-less bots together`,
      () =>
        Promise.all([
          p
            .openViewers(channel, { chromium: browsers, http: PLAIN - browsers, httpTiming: STEADY_TIMING })
            .then((vs) => {
              for (const v of vs) ctx.defer(() => v.stop());
              return vs;
            }),
          ...household.map((v) => v.start()),
          hidden.start(),
          swarm.start(),
          ...fetchless.map((v) => v.start()),
        ]),
    );
    const honest: Viewer[] = [...plain, ...household, hidden];
    const placements: Placement[] = [
      ...(await Promise.all(plain.map(async (v) => ({ id: v.id, source: (await v.report()).source })))),
      ...[...household, ...swarm.members].map((v) => ({ id: v.id, source: v.assignment?.source ?? null })),
      { id: hidden.id, source: hidden.assignment?.source ?? null },
      ...fetchless.map((v) => ({ id: v.id, source: v.assignment?.source ?? null })),
    ];
    ctx.data("placements", placements);
    ctx.assert(
      "no session of the origin cases was sent to the CDN (they started before any viewer was verified?)",
      onCdn(placements).length === 0,
      { onCdn: onCdn(placements), hint: `CDN_BURST_VIEWER_THRESHOLD should be ${expected - 1} for this scenario` },
    );

    const firstFrames = await ctx.step("honest first frames", () =>
      Promise.allSettled(honest.map((v) => v.waitForFirstFrame(60_000))),
    );
    const started = firstFrames.filter((r) => r.status === "fulfilled").length;
    ctx.assert("every honest viewer started playback", started === honest.length, {
      started,
      honest: honest.length,
    });
    ctx.assert("every bot opened a session", swarm.sessionIds.length === bots, { sessions: swarm.sessionIds.length });
    ctx.assert(
      "every fetch-less bot opened a session",
      fetchless.every((f) => f.sessionId !== null),
      fetchless.map((f) => f.sessionId),
    );

    let maxSeen = 0;
    let last = { verified: 0, pending: 0, excluded: 0 };
    const converged = await ctx.step(`count converges to ${expected} with the bots excluded`, async () => {
      const t0 = Date.now();
      await waitFor(
        `count ${expected}, ${bots} excluded`,
        async () => {
          const count = (await p.viewerCount(channel)) ?? 0;
          maxSeen = Math.max(maxSeen, count);
          last = (await streamer.api.client.stream.health({ channel })).viewers;
          return count === expected && last.excluded >= bots;
        },
        { timeoutMs: convergeMs, intervalMs: 2_000, signal: ctx.signal },
      );
      return Date.now() - t0;
    });
    ctx.metric("viewer_count.converge", converged, "ms");
    ctx.metric("sessions.excluded", last.excluded);
    ctx.check("public count never counted a bot", maxSeen <= expected, { maxSeen, expected });

    // Stable: several more scoring runs (every 15 s) must not let a bot back in or drop an
    // honest viewer, while one tab is in the background. Every simulated client shares one
    // address unless the API trusts the harness proxy, so a rate-limited read is retried rather
    // than failing the run.
    const stableMs = Math.max(40_000, hiddenMs);
    await ctx.step(`count stays at ${expected} with one tab hidden`, async () => {
      const samples: number[] = [];
      // Active sessions by verdict at each sample: a dip with fewer active sessions is a missed
      // heartbeat, one with more pending or excluded is a scoring run changing a verdict.
      const breakdown: ({ verified: number; pending: number; excluded: number } | null)[] = [];
      // On a dip: each honest session's heartbeat age and verdict (session → viewer id).
      const dips: { sample: number; sessions: Awaited<ReturnType<typeof heartbeatAges>> }[] = [];
      const honestIds = new Map<string, string>();
      for (const v of honest) {
        const sid = (await v.report()).sessionId;
        if (sid) honestIds.set(sid, v.id);
      }
      const dbUrl = process.env.DATABASE_URL;
      if (hiddenMs > 0) hidden.hide();
      const showAt = Date.now() + hiddenMs;
      const until = Date.now() + stableMs;
      while (Date.now() < until) {
        await Bun.sleep(5_000);
        if (Date.now() >= showAt) hidden.show();
        const { count } = await waitFor(
          "viewer count read",
          () => p.viewerCount(channel).then((c) => ({ count: c ?? 0 })),
          { timeoutMs: 20_000, intervalMs: 2_000, signal: ctx.signal },
        );
        samples.push(count);
        if (count !== expected && dbUrl) {
          dips.push({
            sample: samples.length - 1,
            sessions: await heartbeatAges(dbUrl, honestIds).catch(() => []),
          });
        }
        // Diagnostic only: a rate-limited read is recorded as null, never fails the step.
        breakdown.push(
          await streamer.api.client.stream.health({ channel }).then(
            (h) => h.viewers,
            () => null,
          ),
        );
      }
      hidden.show();
      maxSeen = Math.max(maxSeen, ...samples);
      ctx.assert(
        `count stays at ${expected} for ${stableMs / 1000} s`,
        samples.every((c) => c === expected),
        {
          samples,
          breakdown,
          dips,
          heartbeats: await Promise.all(
            honest.map(async (v) => {
              const r = await v.report();
              return { viewer: v.id, beats: r.heartbeats, errors: r.heartbeatErrors };
            }),
          ),
          beatsWhileHidden: hidden.beatsWhileHidden,
        },
      );
      ctx.check("the hidden tab sent heartbeats while hidden", hidden.beatsWhileHidden > 0, {
        beatsWhileHidden: hidden.beatsWhileHidden,
      });
    });

    const url = process.env.DATABASE_URL;
    if (url) {
      const rows = await ctx.step("bot verdicts and reasons", () => sessionRows(url, swarm.sessionIds));
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

      const fetchlessIds = fetchless.flatMap((f) => (f.sessionId ? [f.sessionId] : []));
      const held = await ctx.step("fetch-less bot verdicts and reasons", () => sessionRows(url, fetchlessIds));
      ctx.assert("every fetch-less bot session is in Postgres", held.length === fetchlessCount, {
        found: held.length,
        fetchlessCount,
      });
      ctx.data(
        "fetchless.rows",
        held.map((r) => ({ verdict: r.verdict, reasons: r.verdict_reasons })),
      );
      ctx.assert(
        "no fetch-less bot verified (pending media_unconfirmed, or excluded on fetch_pattern)",
        held.every((r) => fetchlessHeld(row(r))),
        held.map((r) => ({ verdict: r.verdict, reasons: r.verdict_reasons })),
      );

      const unusual = [...household, hidden].flatMap((v) => (v.sessionId ? [v.sessionId] : []));
      const fine = await ctx.step("unusual honest viewers' verdicts", () => sessionRows(url, unusual));
      ctx.data(
        "unusual.rows",
        fine.map((r) => ({ verdict: r.verdict, reasons: r.verdict_reasons })),
      );
      ctx.assert(
        "the household and the hidden-tab viewer are verified (no false positive)",
        fine.length === householdCount + 1 && fine.every((r) => r.verdict === "verified"),
        fine.map((r) => ({ verdict: r.verdict, reasons: r.verdict_reasons })),
      );
      ctx.check(
        "origin-delivered honest viewers are gate-eligible",
        fine.every((r) => gateEligible(row(r))),
        fine.map((r) => r.verdict_reasons),
      );
    } else {
      ctx.log.warn("DATABASE_URL not set: per-session reasons not checked (counts only)");
    }

    // CDN bot ---------------------------------------------------------------------------
    const cdnStep = "CDN bot: a session the API assigns to the CDN";
    const cdnOff = excludedNeeds(["cdn"], ctx.profile).length > 0 ? null : await p.probe("cdn");
    if (cdnOff) ctx.skipStep(cdnStep, cdnOff);
    const cdnBot = cdnOff
      ? undefined
      : await ctx.optionalStep(cdnStep, ["cdn"], async () => {
          for (let i = 0; i < cdnAttempts; i++) {
            const v = new HeartbeatOnlyViewer({ id: `cdn-bot-${i}`, api: p.api().client, channel, log: p.log });
            ctx.defer(() => v.stop());
            await v.start();
            if (v.assignment?.source === "cdn") return v;
            await v.stop();
          }
          return null;
        });
    const verdictStep = "CDN bot: fetch_unjudged, not gate-eligible, no stream-hour credit";
    if (cdnBot === null) {
      ctx.skipStep(
        verdictStep,
        `no session was assigned cdn in ${cdnAttempts} tries: the API sends sessions to the CDN only while the channel's verified viewers exceed CDN_BURST_VIEWER_THRESHOLD (set it to ${expected - 1} on the stack under test)`,
      );
    } else if (cdnBot && !url) {
      ctx.skipStep(verdictStep, "DATABASE_URL not set: the CDN bot's reasons cannot be read");
    } else if (cdnBot && url) {
      const sid = cdnBot.sessionId ?? "";
      const settled = await ctx.step("CDN bot: scored with enough heartbeats", () =>
        waitFor(
          "CDN bot scored with fetch_unjudged",
          async () => {
            const [r] = await sessionRows(url, [sid]);
            return r && cdnBotSettled(row(r)) ? r : null;
          },
          { timeoutMs: 120_000, intervalMs: 3_000, signal: ctx.signal },
        ),
      );
      ctx.data("cdn.row", row(settled));
      ctx.assert(
        "the CDN bot's reasons include fetch_unjudged",
        (settled.verdict_reasons ?? []).includes("fetch_unjudged"),
      );
      ctx.assert("the CDN bot is not gate-eligible", !gateEligible(row(settled)), row(settled));
      ctx.check(
        "the CDN bot verified on the other signals (its verdict does not change)",
        settled.verdict === "verified",
        {
          verdict: settled.verdict,
        },
      );

      const secret = internalSecret(ctx.env);
      const hoursStep = "CDN bot: its hour does not count toward stream-hour eligibility";
      if (!secret) {
        ctx.skipStep(hoursStep, "INTERNAL_API_SECRET not set: cannot run the stream-hours pass through the test hook");
      } else {
        const hooks = new CoopHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
        const tick = async (): Promise<boolean> => {
          const before = hooks.ticks.length;
          try {
            await hooks.tickRan("stream-hours");
          } catch (err) {
            if (!(err instanceof CoopHooksOff)) throw err;
          }
          return hooks.ticks.slice(before).some((t) => t.result !== null && (t.result.skipped ?? 0) === 0);
        };
        if (!(await tick())) {
          ctx.skipStep(hoursStep, "the co-op test hook is off (harness/compose.e5-coop.yaml, COOP_TEST_HOOKS=true)");
        } else {
          await ctx.step(hoursStep, async () => {
            // The job's count is an aggregate, so the bot is proved out by difference: the same
            // count with and without the fetch-judged condition, recomputed here, must match the
            // job's figure and exceed it by exactly the bot. A scoring pass (every 15 s) between
            // the job and this read can move a session, so a mismatch reruns the job first.
            let hour: HourCounts | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) await tick();
              hour = await hourCounts(url, sid);
              if (hour && hour.gate === hour.n) break;
            }
            ctx.data("cdn.stream_hour", hour);
            ctx.assert("the broadcast has a stream_hours row", hour !== null);
            if (!hour) return;
            ctx.assert(
              "the CDN bot would count without the marker (verified, scored, overlaps the hour, not the streamer's network)",
              hour.botCandidate === 1,
              hour,
            );
            ctx.assert("the recomputed gate-eligible count matches the job's figure", hour.gate === hour.n, hour);
            ctx.assert(
              "the CDN bot is not counted among the hour's verified viewers (exactly it is left out)",
              hour.scored === hour.n + 1,
              hour,
            );
            ctx.check("the hour counts exactly the honest viewers", hour.n === expected, { n: hour.n, expected });
          });
        }
      }
    }

    await ctx.step("stop", () =>
      Promise.all([swarm.stop(), ...honest.map((v) => v.stop()), ...fetchless.map((f) => f.stop()), cdnBot?.stop()]),
    );
  },
});
