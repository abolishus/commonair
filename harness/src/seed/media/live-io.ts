// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `seed live`'s real dependencies: the refusal checks against the database, signed-in seeded
 * accounts, one ffmpeg test-pattern publisher per channel (`Streamer`), and chat clients that say
 * the planned lines. `live.ts` supervises them.
 */
import { loadEnv, seedEnv } from "@commonair/config";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { createDb } from "@commonair/db";
import { createLogger } from "@commonair/observability";
import { ChatClient } from "../../chat-client.ts";
import { loadHarnessEnv } from "../../env.ts";
import { type Fingerprint, newDeviceId, realisticFingerprint } from "../../fingerprint.ts";
import { HttpViewer } from "../../http-viewer.ts";
import { internalSecret } from "../../safety-io.ts";
import { Streamer, rtmpPublishUrl } from "../../streamer.ts";
import { type SignedInUser, UserFactory } from "../../users.ts";
import { sleep } from "../../wait.ts";
import {
  BYPASS_RENEW_MS,
  CHAT_GAP_MS,
  DEFAULT_LIVE_CHANNELS,
  type LiveDeps,
  REQUIRED_LOGINS,
  liveAvailable,
  liveRefusals,
  nextLine,
  planLive,
  renewUntilAborted,
  runLive,
} from "../live.ts";
import { seedApiFactory, stopSeedProxy } from "../clients.ts";
import { type WatcherDeps, planWatchers, runWatchers } from "../live-viewers.ts";
import { AnalyticsHooks } from "../safety/api.ts";
import { createRng } from "../prng.ts";

/** The PRNG seed of `seed live` (it takes no `--seed`: the same channels and lines every time). */
export const LIVE_SEED = 1;

export interface SeedLiveCommand {
  channels: number;
  durationMs?: number;
  out?: (line: string) => void;
  source?: Record<string, string | undefined>;
  /**
   * Stops the run (the `seed-coverage` scenario's teardown). Without it the command stops on
   * SIGINT or SIGTERM (`selfhost.sh seed-mode close` sends SIGTERM).
   */
  signal?: AbortSignal;
  /** Each chatter's wait between lines; `CHAT_GAP_MS` by default. */
  chatGapMs?: readonly [number, number];
  /** Seeded viewers watching through the real playback path (`live-viewers.ts`); on by default. */
  watchers?: boolean;
}

/** A watch session that got no video segment for this long is renewed (a live segment is ~2 s). */
export const WATCH_STALE_MS = 60_000;

interface Login {
  username: string;
  channelId: string | null;
  email: string;
  slug: string | null;
  restricted: boolean;
  adult: boolean;
  gated: boolean;
}

export async function runSeedLiveCommand(o: SeedLiveCommand): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const source = o.source ?? process.env;
  const { DEMO_SEED_FULL } = loadEnv(seedEnv, source);
  const env = loadHarnessEnv(source);
  const password = source.DEMO_SEED_PASSWORD?.trim() || undefined;
  const url = env.DATABASE_URL;
  const handle = url ? createDb({ url, max: 2, applicationName: "commonair-seed-live" }) : undefined;
  let logins: Login[] = [];
  try {
    if (handle && DEMO_SEED_FULL)
      logins = await handle.sql<Login[]>`
        select u.username, u.email, c.slug, c.id as "channelId",
               (u.banned or u.deleted_at is not null
                or exists (select 1 from account_deletions d where d.user_id = u.id and d.status = 'scheduled')
                or exists (select 1 from chat_bans b where b.user_id = u.id)
                or exists (select 1 from user_blocks k where k.blocked_user_id = u.id)
               ) as restricted,
               u.mature_confirmed_at is not null as adult,
               coalesce(c.mature or exists (select 1 from categories g where g.id = c.category_id and g.mature), false)
                 as gated
          from users u left join channels c on c.owner_id = u.id
         where u.username like 'demo\\_%' and u.email like '%@demo-seed.invalid'`;
  } finally {
    await handle?.close();
  }
  const have = new Set(logins.map((l) => l.username));
  const refusals = liveRefusals({
    seedFull: DEMO_SEED_FULL,
    password,
    databaseUrl: url,
    missingLogins: REQUIRED_LOGINS.filter((u) => !have.has(u)),
  });
  if (refusals.length > 0 || !password) {
    for (const r of refusals) out(`refused: ${r}`);
    return 2;
  }

  const handleOf = (username: string) => username.replace(/^demo_/, "");
  const available = liveAvailable(
    logins.map((l) => ({
      handle: handleOf(l.username),
      slug: l.slug,
      restricted: l.restricted,
      adult: l.adult,
      gated: l.gated,
    })),
  );
  const rng = createRng(LIVE_SEED).fork("live");
  const plan = planLive(rng, available, o.channels > 0 ? o.channels : DEFAULT_LIVE_CHANNELS);
  const gap = o.chatGapMs ?? CHAT_GAP_MS;

  const log = createLogger({ service: "harness-seed-live", level: env.LOG_LEVEL });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("interrupted"));
  if (o.signal) {
    if (o.signal.aborted) controller.abort(o.signal.reason);
    else o.signal.addEventListener("abort", onSignal, { once: true });
  } else {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  const timer =
    o.durationMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("duration")), o.durationMs);
  // Through the seed's forwarding proxy, each account from its own simulated address, as the units
  // sign in: the auth rate limit is per address, and the coverage walk signs in right after.
  const users = new UserFactory({
    apiUrl: env.HARNESS_API_URL,
    webOrigin: new URL(env.HARNESS_WEB_URL).origin,
    mailpitUrl: env.HARNESS_MAILPIT_URL,
    mailpitAuth: env.HARNESS_MAILPIT_AUTH,
    emailDomain: DEMO_FIXTURES.emailDomain,
    apiFactory: seedApiFactory(env, "media"),
  });
  const emailOf = new Map(logins.map((l) => [handleOf(l.username), l.email]));
  const sessions = new Map<string, Promise<SignedInUser>>();
  const signIn = (h: string): Promise<SignedInUser> => {
    let p = sessions.get(h);
    if (!p) {
      const email = emailOf.get(h);
      if (!email) throw new Error(`no seeded login ${h}`);
      p = users.signIn({ username: `demo_${h}`, displayName: h, email, password, birthDate: "" });
      // A failed sign-in is not kept: the publisher's restart signs in again.
      p.catch(() => sessions.delete(h));
      sessions.set(h, p);
    }
    return p;
  };
  const deps: LiveDeps = {
    async startPublisher(c) {
      const u = await signIn(c.handle);
      const { key } = await u.api.client.stream.rotateKey({ channel: c.slug });
      const s = new Streamer({
        protocol: "rtmp",
        url: rtmpPublishUrl(env.HARNESS_RTMP_URL, key),
        name: `seed-live-${c.handle}`,
        width: 640,
        height: 360,
        bitrateKbps: 800,
        log,
      });
      await s.start();
      return { exited: s.exited ?? Promise.resolve(0), stop: () => s.stop() };
    },
    async startChatter(ch) {
      const u = await signIn(ch.handle);
      const r = rng.fork(`line:${ch.seed}`);
      const stop = new AbortController();
      const signal = AbortSignal.any([stop.signal, controller.signal]);
      let client: ChatClient | null = null;
      const loop = (async () => {
        while (!signal.aborted) {
          try {
            if (!client?.isOpen) {
              client = await ChatClient.connectWithApi(u.api.client, log);
              await client.join(ch.channel);
            }
            const line = nextLine(r, ch.owner, gap);
            await sleep(line.gapMs, signal);
            // A refused line (slow mode, followers-only) is fine: the next one tries again.
            await client.send(ch.channel, line.body).catch(() => null);
          } catch {
            if (signal.aborted) break;
            client?.close();
            client = null;
            await sleep(5_000, signal).catch(() => undefined);
          }
        }
      })();
      return {
        stop: async () => {
          stop.abort();
          client?.close();
          await loop;
        },
      };
    },
    watchUrl: (c) => `${env.HARNESS_WEB_URL.replace(/\/+$/, "")}/${c.slug}`,
    out,
    sleep: (ms, signal) => sleep(ms, signal),
  };
  // A long-running process: a stray rejection (a chat waiter, a publisher's restart) is logged, and
  // the streams keep going, instead of Bun ending the process on it.
  const onStray = (err: unknown) =>
    log.warn("seed live: ignored an unhandled failure", { error: err instanceof Error ? err.message : String(err) });
  process.on("unhandledRejection", onStray);
  // The verified audience: each viewer keeps its device and fingerprint across its sessions.
  const devices = new Map<string, { deviceId: string; fingerprint: Fingerprint }>();
  const watcherDeps: WatcherDeps = {
    async startWatch(w) {
      const u = await signIn(w.handle);
      let device = devices.get(w.handle);
      if (!device) {
        device = { deviceId: newDeviceId(), fingerprint: realisticFingerprint() };
        devices.set(w.handle, device);
      }
      const v = new HttpViewer({ target: { channel: w.channel }, api: u.api.client, ...device, log });
      try {
        await v.start();
      } catch (err) {
        await v.stop().catch(() => undefined);
        throw err;
      }
      const startedAt = Date.now();
      return {
        async healthy() {
          if ((await v.report()).errors.length > 0) return false;
          return Date.now() - (v.lastSegmentAt ?? startedAt) < WATCH_STALE_MS;
        },
        stop: async () => {
          await v.stop();
        },
      };
    },
    out,
    sleep: (ms, signal) => sleep(ms, signal),
    now: () => Date.now(),
  };
  const watchers =
    o.watchers === false
      ? []
      : planWatchers(rng.fork("watchers"), plan.channels, available.viewers, plan.chatters, available.adults);
  const watching = runWatchers(watchers, rng.fork("watching"), watcherDeps, controller.signal);
  // Keeps /analytics showing streamer1's history while the streams run (BYPASS_RENEW_MS says why).
  const secret = internalSecret(env, source);
  const s1 = logins.find((l) => l.username === "demo_streamer1")?.channelId;
  const bypass =
    secret && s1
      ? renewUntilAborted(
          () => new AnalyticsHooks(env.HARNESS_API_URL, secret, controller.signal).bypass(s1, true),
          BYPASS_RENEW_MS,
          controller.signal,
          deps,
        )
      : Promise.resolve();
  try {
    return await runLive(plan, deps, controller.signal);
  } catch (err) {
    out(`seed live: failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("unhandledRejection", onStray);
    controller.abort();
    await bypass;
    const watched = await watching;
    if (watchers.length > 0)
      out(`seed live: viewers ran ${watched.sessions} watch sessions (${watched.renewed} renewed after losing media)`);
    await stopSeedProxy();
  }
}
