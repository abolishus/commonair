// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `seed live --channels K` (seed-media): keep K seeded channels live (the fixed streamers first,
 * then bulk streamers) with seeded bulk viewers chatting at a bounded rate, until SIGINT, SIGTERM
 * or `--duration`. A publisher that dies is restarted. Refuses unless `DEMO_SEED_FULL=true`, the
 * password is given and the database already holds a full seed. The `seed-coverage` scenario runs
 * it for its walk (streamer1 and streamer2, faster chat); staging seed mode runs it detached after
 * `seed full` until `seed-mode close` (scripts/selfhost.sh).
 *
 * The plan and the supervisor are pure over injected dependencies (a fake process runner in the
 * tests); `media/live-io.ts` wires them to ffmpeg, the API and chat.
 */
import { ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS } from "@commonair/contracts/internal";
import { FIXED_ACCOUNTS } from "./accounts.ts";
import { CHAT_LINES, fillLine } from "./media/content.ts";
import type { Rng } from "./prng.ts";

/** The fixed streamers in the order they go live. */
export const LIVE_FIXED_ORDER = ["streamer1", "streamer2", "streamer3", "council1", "council2"] as const;
/** Chatters per live channel. */
export const CHATTERS_PER_CHANNEL = 3;
/** Each chatter waits this long between lines (ms): about 3–7 lines a minute per channel. */
export const CHAT_GAP_MS: readonly [number, number] = [25_000, 60_000];
/**
 * The `seed-coverage` walk's cadence: chat reaches a page only over its socket (no history on
 * join), so a channel page judged within seconds of loading needs a line every second or two.
 */
export const COVERAGE_CHAT_GAP_MS: readonly [number, number] = [1_500, 4_000];
/** Channels the `seed-coverage` walk keeps live: streamer1 (/, its page, embed, dashboard) and streamer2. */
export const COVERAGE_LIVE_CHANNELS = 2;
/** Wait before restarting a publisher that died. */
export const RESTART_BACKOFF_MS = 3_000;
/** Consecutive failed starts after which a channel is given up (the run then exits 1). */
export const MAX_START_FAILURES = 5;
export const DEFAULT_LIVE_CHANNELS = 3;

export interface LiveChannel {
  handle: string;
  slug: string;
  /**
   * The channel or its category is mature: playback needs a signed-in viewer who confirmed they
   * are 18 or older, so only such viewers watch it (`planWatchers`).
   */
  gated?: boolean;
}

export interface LiveChatter {
  handle: string;
  /** The channel's slug. */
  channel: string;
  owner: string;
  /** Deterministic stream of this chatter's lines and gaps. */
  seed: string;
}

export interface LivePlan {
  channels: LiveChannel[];
  chatters: LiveChatter[];
  /** Asked for more channels than streamers exist. */
  short: number;
}

export interface LiveAvailable {
  /** Streamers with a channel: fixed and bulk (`s0001`…), any order. */
  streamers: readonly LiveChannel[];
  /** Bulk viewer handles. */
  viewers: readonly string[];
  /** The bulk viewers who confirmed they are 18 or older, the only ones a gated channel admits. */
  adults?: readonly string[];
}

/** Channels: the fixed streamers in `LIVE_FIXED_ORDER`, then bulk streamers by handle. Pure. */
export function planLive(rng: Rng, available: LiveAvailable, k: number): LivePlan {
  const byHandle = new Map(available.streamers.map((s) => [s.handle, s]));
  const fixed = LIVE_FIXED_ORDER.flatMap((h) => {
    const s = byHandle.get(h);
    return s ? [s] : [];
  });
  const bulk = available.streamers
    .filter((s) => /^s\d+$/.test(s.handle))
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const ordered = [...fixed, ...bulk];
  const channels = ordered.slice(0, Math.max(0, k));
  const viewers = rng.fork("chatters").shuffle([...available.viewers].sort());
  const chatters: LiveChatter[] = [];
  let next = 0;
  for (const c of channels)
    for (let i = 0; i < CHATTERS_PER_CHANNEL && viewers.length > 0; i++) {
      const handle = viewers[next++ % viewers.length] as string;
      chatters.push({ handle, channel: c.slug, owner: c.handle, seed: `${c.handle}:${i}` });
    }
  return { channels, chatters, short: Math.max(0, k - ordered.length) };
}

/** The next line and the wait before it, for a chatter's PRNG stream. Pure. */
export function nextLine(
  r: Rng,
  owner: string,
  gapMs: readonly [number, number] = CHAT_GAP_MS,
): { gapMs: number; body: string } {
  return { gapMs: r.int(gapMs[0], gapMs[1]), body: fillLine(r.pick(CHAT_LINES), owner) };
}

/** A seeded login as `seed live` reads it from the database. */
export interface LiveLogin {
  /** Without the `demo_` prefix. */
  handle: string;
  slug: string | null;
  /**
   * Suspended, deleted or scheduled for deletion, banned from a channel's chat, or blocked by a
   * fixed login: never a chatter (signing in would change its state, or its lines would not show).
   */
  restricted: boolean;
  /** Confirmed 18 or older (`users.mature_confirmed_at`). */
  adult?: boolean;
  /** Its channel, if any, is mature or in a mature category. */
  gated?: boolean;
}

const STREAMS = new Set<string>(LIVE_FIXED_ORDER);

/** Who streams (restricted or not: the fixed streamers are never suspended) and who chats. Pure. */
export function liveAvailable(logins: readonly LiveLogin[]): LiveAvailable {
  const viewers = logins.filter((l) => !l.restricted && /^v\d+$/.test(l.handle));
  return {
    streamers: logins.flatMap((l) =>
      l.slug && (STREAMS.has(l.handle) || /^s\d+$/.test(l.handle))
        ? [{ handle: l.handle, slug: l.slug, ...(l.gated ? { gated: true } : {}) }]
        : [],
    ),
    viewers: viewers.map((l) => l.handle),
    adults: viewers.filter((l) => l.adult === true).map((l) => l.handle),
  };
}

/**
 * The slugs `seed live` streams first (`planLive`'s fixed order), for the `seed-coverage` walk to
 * wait on. Pure.
 */
export function fixedLiveSlugs(channels: readonly { ownerHandle: string; slug: string }[], k: number): string[] {
  return LIVE_FIXED_ORDER.flatMap((h) => channels.filter((c) => c.ownerHandle === h).map((c) => c.slug)).slice(
    0,
    Math.max(0, k),
  );
}

export interface LiveRefusalInput {
  seedFull: boolean;
  password: string | undefined;
  databaseUrl: string | undefined;
  /** Fixed logins the database lacks (all of them on an unseeded database). */
  missingLogins: readonly string[];
}

/** Why `seed live` refuses (exit 2), empty when it may run. Pure. */
export function liveRefusals(i: LiveRefusalInput): string[] {
  const out: string[] = [];
  if (!i.seedFull) out.push("DEMO_SEED_FULL is not true (local and staging only)");
  if (!i.password) out.push("DEMO_SEED_PASSWORD is not set (the shared password `seed full` used)");
  if (!i.databaseUrl) out.push("DATABASE_URL is not set");
  else if (i.missingLogins.length > 0)
    out.push(
      `the database holds no full seed (missing ${i.missingLogins.slice(0, 5).join(", ")}${i.missingLogins.length > 5 ? ", …" : ""}); run seed full first`,
    );
  return out;
}

/** The fixed human logins `seed live` expects (by username). */
export const REQUIRED_LOGINS = FIXED_ACCOUNTS.filter((a) => !a.bot).map((a) => `demo_${a.handle}`);

export interface PublisherHandle {
  /** Resolves with the exit code when the publisher ends on its own or is stopped. */
  exited: Promise<number>;
  stop(): Promise<void>;
}

export interface ChatterHandle {
  stop(): Promise<void>;
}

export interface LiveDeps {
  startPublisher(channel: LiveChannel): Promise<PublisherHandle>;
  /** Starts the chatter's own loop (until `stop`). */
  startChatter(chatter: LiveChatter): Promise<ChatterHandle>;
  watchUrl(channel: LiveChannel): string;
  out(line: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** Keep one channel live until `signal`; restart its publisher when it dies. Resolves true if it gave up. */
async function superviseChannel(c: LiveChannel, deps: LiveDeps, signal: AbortSignal): Promise<boolean> {
  let failures = 0;
  let restarts = 0;
  const stopped = aborted(signal);
  while (!signal.aborted) {
    let p: PublisherHandle;
    try {
      p = await deps.startPublisher(c);
    } catch (err) {
      failures++;
      deps.out(
        `seed live: ${c.slug}: the publisher did not start (${err instanceof Error ? err.message : String(err)})`,
      );
      if (failures >= MAX_START_FAILURES) {
        deps.out(`seed live: ${c.slug}: giving up after ${failures} failed starts`);
        return true;
      }
      await deps.sleep(RESTART_BACKOFF_MS, signal).catch(() => undefined);
      continue;
    }
    failures = 0;
    if (signal.aborted) {
      await p.stop();
      break;
    }
    const outcome = await Promise.race([p.exited.then((code) => ({ code })), stopped.then(() => null)]);
    if (outcome === null) {
      await p.stop();
      break;
    }
    restarts++;
    deps.out(`seed live: ${c.slug}: the publisher exited (code ${outcome.code}); restart #${restarts}`);
    await deps.sleep(RESTART_BACKOFF_MS, signal).catch(() => undefined);
  }
  return false;
}

/**
 * How often `seed live` renews streamer1's analytics display bypass (half its TTL). seed-safety
 * turns it on, but it is a Valkey key that lapses after an hour, and a resumed seed flushes Valkey:
 * without it, `/analytics` and attestations wait out the 24 h display delay again.
 */
export const BYPASS_RENEW_MS = (ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS * 1000) / 2;

/**
 * Calls `renew` now and then every `everyMs` until `signal` aborts. A failure is reported and the
 * next tick tries again: losing the bypass must never stop the streams.
 */
export async function renewUntilAborted(
  renew: () => Promise<void>,
  everyMs: number,
  signal: AbortSignal,
  deps: Pick<LiveDeps, "sleep" | "out">,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await renew();
    } catch (err) {
      if (signal.aborted) return;
      deps.out(
        `seed live: renewing the analytics display bypass failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      await deps.sleep(everyMs, signal);
    } catch {
      return;
    }
  }
}

/** Run the plan until `signal`. Exit code 0 clean, 1 when a channel could not be kept live. */
export async function runLive(plan: LivePlan, deps: LiveDeps, signal: AbortSignal): Promise<number> {
  if (plan.channels.length === 0) {
    deps.out("seed live: no seeded channel to stream");
    return 1;
  }
  if (plan.short > 0)
    deps.out(`seed live: only ${plan.channels.length} seeded channels exist (${plan.short} fewer than asked)`);
  const supervisors = plan.channels.map((c) => superviseChannel(c, deps, signal));
  const chatters: ChatterHandle[] = [];
  try {
    for (const ch of plan.chatters) {
      if (signal.aborted) break;
      try {
        chatters.push(await deps.startChatter(ch));
      } catch (err) {
        deps.out(
          `seed live: chatter ${ch.handle} on ${ch.channel} did not start (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    deps.out("seed live: watch at");
    for (const c of plan.channels) deps.out(`  ${deps.watchUrl(c)}`);
    deps.out("seed live: Ctrl+C to stop");
    const gaveUp = await Promise.all(supervisors);
    return gaveUp.some(Boolean) ? 1 : 0;
  } finally {
    await Promise.all(chatters.map((c) => c.stop().catch(() => undefined)));
    // A supervisor that is still running (a failure path) stops with the signal; wait for it.
    await Promise.allSettled(supervisors);
  }
}
