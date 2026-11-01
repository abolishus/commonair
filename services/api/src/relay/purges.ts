// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `relays.purges`: the signed relay purge feed (batch 7 decision (x), ADR 0016 Amendment 1 A1.2).
 *
 * `GET /api/relay/purges?after=<seq>` with the relay's bearer token answers the `relay_purges`
 * rows after `after`, oldest first, at most `RELAY_PURGE_RULES.maxItems`, as a `SignedPurgeBatch`
 * signed with the origin playback key (relays hold its public half as `originPublicKey`).
 *
 * - **Hold.** With nothing new the request is held up to `RELAY_PURGE_RULES.holdSeconds` (the
 *   harness hook `KEYS.relayPurgeHold` shortens it), woken early by the emitter's pub/sub nudge
 *   (`RELAY_PURGE_NUDGE_CHANNEL`). A lost nudge costs at most `POLL_FALLBACK_MS`: the held request
 *   also re-reads the table on that interval, and every second when the subscriber is down.
 * - **Reset.** A cursor below the cleanup's watermark (`RELAY_PURGE_WATERMARK_KEY`: the highest
 *   `seq` deleted) missed rows that are gone: the answer is `{seq, items: [], reset: true}` and
 *   the relay evicts every cached `live/` and `dvr/` object. So is a cursor above every `seq` this
 *   database has issued (a relay that kept its state across a database reset), which would
 *   otherwise wait for rows it can never get. The answer's `seq` is the newest known `seq`.
 * - **Ordering.** The emitter inserts under one advisory lock, so `seq` order is commit order and
 *   a row is never committed below a cursor already handed out.
 */
import { asc, gt, sql } from "drizzle-orm";
import { RELAY_PURGE_RULES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { signPurgeBatch, type PurgeBatch, type SignedPurgeBatch } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { apiError } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

/**
 * The emitter's nudge channel (`services/worker/src/relay-purge/emit.ts`). Contract request:
 * `BUS.relayPurges` in `@commonair/contracts/events`.
 */
export const RELAY_PURGE_NUDGE_CHANNEL = "bus:relay-purges";
/**
 * The cleanup's deleted-seq watermark (`services/worker/src/relay-purge/cleanup.ts`). Contract
 * request: `KEYS.relayPurgeWatermark` in `@commonair/contracts/internal`.
 */
export const RELAY_PURGE_WATERMARK_KEY = "relay-purge:watermark";
/** How often a held request re-reads the table even without a nudge. */
export const POLL_FALLBACK_MS = 5_000;
/** The same while the subscriber is down. */
const POLL_DEGRADED_MS = 1_000;

type Subscriber = ReturnType<typeof createValkey>;

/** One subscriber per API process, shared by every held request. */
export class PurgeWaker {
  private sub: Subscriber | null = null;
  private ready: Promise<boolean> | null = null;
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly connect: (url: string) => Subscriber = (u) => createValkey(u, { name: "api-relay-purge-sub" }),
  ) {}

  /** Subscribe once; true when nudges can arrive. A failure is forgotten so the next call retries. */
  listen(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (!this.ready) {
      const sub = this.connect(this.url);
      sub.on("error", (err: Error) => this.logger.warn("relay purge subscriber error", { err: err.name }));
      sub.on("message", (channel: string) => {
        if (channel === RELAY_PURGE_NUDGE_CHANNEL) this.wakeAll();
      });
      this.sub = sub;
      const ready = sub.subscribe(RELAY_PURGE_NUDGE_CHANNEL).then(
        () => true,
        () => {
          if (this.ready === ready) {
            this.ready = null;
            this.sub = null;
            sub.disconnect();
          }
          return false;
        },
      );
      this.ready = ready;
    }
    return this.ready;
  }

  /** A promise that resolves on the next nudge; `cancel` releases it. */
  arm(): { woken: Promise<void>; cancel: () => void } {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.waiters.add(wake);
    return { woken, cancel: () => this.waiters.delete(wake) };
  }

  private wakeAll(): void {
    const all = [...this.waiters];
    this.waiters.clear();
    for (const w of all) w();
  }

  get listeners(): number {
    return this.waiters.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wakeAll();
    this.sub?.disconnect();
    this.sub = null;
    this.ready = null;
  }
}

const wakers = new WeakMap<Deps, PurgeWaker>();

export function purgeWaker(deps: Deps): PurgeWaker {
  let w = wakers.get(deps);
  if (!w) {
    w = new PurgeWaker(deps.env.VALKEY_URL, deps.logger);
    wakers.set(deps, w);
  }
  return w;
}

/** Close the process's subscriber (contract request: listed in `buildDeps().close`). */
export async function closeRelayPurgeFeed(deps: Deps): Promise<void> {
  await wakers.get(deps)?.close();
  wakers.delete(deps);
}

/** The hold for an empty answer: the test hook's seconds (1–25) or the default. */
async function holdMs(deps: Deps): Promise<number> {
  const raw = Number(await deps.valkey.get(KEYS.relayPurgeHold));
  const seconds = Number.isInteger(raw) && raw >= 1 && raw <= RELAY_PURGE_RULES.holdSeconds ? raw : null;
  return (seconds ?? RELAY_PURGE_RULES.holdSeconds) * 1000;
}

/** The batch for `after` right now; null when there is nothing to say yet. */
export async function purgeBatchAfter(deps: Deps, after: number): Promise<PurgeBatch | null> {
  const p = schema.relayPurges;
  const watermark = Number((await deps.valkey.get(RELAY_PURGE_WATERMARK_KEY)) ?? 0) || 0;
  const [top] = await deps.db.select({ seq: sql<string | null>`max(${p.seq})` }).from(p);
  const newest = Math.max(top?.seq === null || top?.seq === undefined ? 0 : Number(top.seq), watermark);
  if (after < watermark || after > newest) return { seq: newest, items: [], reset: true };
  const rows = await deps.db
    .select({ seq: p.seq, prefix: p.prefix, reason: p.reason })
    .from(p)
    .where(gt(p.seq, after))
    .orderBy(asc(p.seq))
    .limit(RELAY_PURGE_RULES.maxItems);
  const last = rows.at(-1);
  return last ? { seq: last.seq, items: rows } : null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Answer a poll: at once when there is something to send, else after the hold (or a nudge). */
export async function answerPurges(deps: Deps, after: number, signal?: AbortSignal): Promise<SignedPurgeBatch> {
  const waker = purgeWaker(deps);
  const deadline = Date.now() + (await holdMs(deps));
  for (;;) {
    const listening = await waker.listen().catch(() => false);
    // Armed before the read, so a nudge between the read and the wait is not lost.
    const armed = waker.arm();
    try {
      const batch = await purgeBatchAfter(deps, after);
      if (batch) return await signPurgeBatch(deps.signingKey, batch);
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) break;
      await Promise.race([armed.woken, sleep(Math.min(left, listening ? POLL_FALLBACK_MS : POLL_DEGRADED_MS), signal)]);
    } finally {
      armed.cancel();
    }
  }
  return signPurgeBatch(deps.signingKey, { seq: after, items: [] });
}

export const relayPurges = os.relays.purges.handler(async ({ context, input, signal }) => {
  const relay = context.relay;
  // The relay protocol's own check (`routes/relays.ts` requireRelay): any non-retired relay,
  // suspended included (its cache must still forget removed media).
  if (!relay) throw apiError("UNAUTHORIZED", "A valid relay token is required");
  if (relay.retiredAt !== null) throw apiError("UNAUTHORIZED", "This relay was retired");
  return answerPurges(context.deps, input.after, signal);
});
