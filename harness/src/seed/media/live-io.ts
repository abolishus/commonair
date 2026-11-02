// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `seed live`'s real dependencies: the refusal checks against the database, signed-in seeded
 * accounts, one ffmpeg test-pattern publisher per channel (`Streamer`), and chat clients that say
 * the planned lines. `live.ts` supervises them.
 */
import { loadEnv, seedEnv } from "@commonair/config";
import { createDb } from "@commonair/db";
import { createLogger } from "@commonair/observability";
import { ChatClient } from "../../chat-client.ts";
import { loadHarnessEnv } from "../../env.ts";
import { Platform } from "../../platform.ts";
import { Streamer, rtmpPublishUrl } from "../../streamer.ts";
import type { SignedInUser } from "../../users.ts";
import { sleep } from "../../wait.ts";
import {
  DEFAULT_LIVE_CHANNELS,
  type LiveChannel,
  type LiveDeps,
  REQUIRED_LOGINS,
  liveRefusals,
  nextLine,
  planLive,
  runLive,
} from "../live.ts";
import { createRng } from "../prng.ts";

/** The PRNG seed of `seed live` (it takes no `--seed`: the same channels and lines every time). */
export const LIVE_SEED = 1;

export interface SeedLiveCommand {
  channels: number;
  durationMs?: number;
  out?: (line: string) => void;
  source?: Record<string, string | undefined>;
}

interface Login {
  username: string;
  email: string;
  slug: string | null;
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
        select u.username, u.email, c.slug
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
  const streamers: LiveChannel[] = logins.flatMap((l) => {
    const h = handleOf(l.username);
    const streams = /^s\d+$/.test(h) || ["streamer1", "streamer2", "streamer3", "council1", "council2"].includes(h);
    return streams && l.slug ? [{ handle: h, slug: l.slug }] : [];
  });
  const viewers = logins.map((l) => handleOf(l.username)).filter((h) => /^v\d+$/.test(h));
  const rng = createRng(LIVE_SEED).fork("live");
  const plan = planLive(rng, { streamers, viewers }, o.channels > 0 ? o.channels : DEFAULT_LIVE_CHANNELS);

  const log = createLogger({ service: "harness-seed-live", level: env.LOG_LEVEL });
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", onSigint);
  const timer =
    o.durationMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("duration")), o.durationMs);
  const platform = new Platform(env, log, `seedlive${Date.now().toString(16)}`);
  const emailOf = new Map(logins.map((l) => [handleOf(l.username), l.email]));
  const sessions = new Map<string, Promise<SignedInUser>>();
  const signIn = (h: string): Promise<SignedInUser> => {
    let p = sessions.get(h);
    if (!p) {
      const email = emailOf.get(h);
      if (!email) throw new Error(`no seeded login ${h}`);
      p = platform.users.signIn({ username: `demo_${h}`, displayName: h, email, password, birthDate: "" });
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
            const line = nextLine(r, ch.owner);
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
  try {
    return await runLive(plan, deps, controller.signal);
  } catch (err) {
    out(`seed live: failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
    controller.abort();
    await platform.close();
  }
}
