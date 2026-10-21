// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test doubles for media moderation. Frames are synthetic byte patterns (never images of anything);
 * the fake PDQ reads a hash and quality planted in the first bytes of the luma buffer, so tests
 * decide which frames "match" without unit A's PDQ.
 */
import type { ModerationScanJob, ModerationT0Job } from "@commonair/contracts/internal";
import type { Database } from "@commonair/db";
import {
  importOpeningKey,
  importSealingKey,
  MODERATION_CONSTANTS,
  type DecodedFrame,
  type HashList,
  type HashMatch,
  type HashMatcher,
  type OpeningKey,
  type PdqHash,
  type SealingKey,
} from "@commonair/moderation";
import { createLogger, type Logger } from "@commonair/observability";
import { createModerationMetrics } from "../../src/moderation/metrics.ts";
import { MediaModeration, type ModerationDeps } from "../../src/moderation/moderation.ts";
import type { ModerationQueue } from "../../src/moderation/queue.ts";
import type { FrameTools } from "../../src/moderation/tools.ts";

const { PDQ_LUMA_SIZE: L, CLASSIFIER_INPUT_SIZE: C } = MODERATION_CONSTANTS;

/** A synthetic frame whose fake PDQ is `hash` (one hex nibble repeated) at `quality`. */
export function fakeFrame(nibble: string, quality: number): DecodedFrame {
  const luma = new Uint8Array(L * L);
  luma[0] = nibble.charCodeAt(0);
  luma[1] = quality;
  const rgb = new Uint8Array(C * C * 3).fill(quality);
  return { luma, rgb };
}

export const fakePdq = (luma: Uint8Array): PdqHash => ({
  hash: String.fromCharCode(luma[0] ?? 48).repeat(64),
  quality: luma[1] ?? 0,
});

/** A fake matcher: hashes in `listed` match exactly (distance 0); quality < 50 never matches. */
export function fakeMatcher(
  listed: Record<string, "csam" | "ncii">,
  version = "sha256:test:1",
): HashMatcher & {
  replaced: HashList[];
} {
  const replaced: HashList[] = [];
  return {
    replaced,
    match(h: PdqHash): HashMatch | null {
      if (h.quality < MODERATION_CONSTANTS.PDQ_MIN_QUALITY) return null;
      const category = listed[h.hash];
      return category
        ? { category, provider: "pdq:operator-list", listVersion: version, distance: 0, quality: h.quality }
        : null;
    },
    replace(l) {
      replaced.push(l);
    },
    lists: () => replaced,
  };
}

export function fakeTools(over: Partial<FrameTools> = {}): FrameTools {
  return {
    pdq: fakePdq,
    decodeImage: async (bytes) => fakeFrame(String.fromCharCode(bytes[0] ?? 48), bytes[1] ?? 0),
    async *sampleVideo() {
      yield { ...fakeFrame("0", 0), atSeconds: 0 };
    },
    // Deterministic "PNG" stand-ins: the evidence tests only check the seal round trip.
    encodePng: async (f) => ({ luma: f.luma.slice(0, 1024), rgb: f.rgb.slice(0, 1024) }),
    ...over,
  };
}

export class FakeQueue implements ModerationQueue {
  scans: ModerationScanJob[] = [];
  t0s: ModerationT0Job[] = [];
  waiting = 0;
  /** Fail this many addT0 calls first. */
  failT0 = 0;
  events: string[] = [];
  async waitingCount() {
    return this.waiting;
  }
  async addScan(job: ModerationScanJob) {
    this.events.push("scan");
    this.scans.push(job);
  }
  async addT0(job: ModerationT0Job) {
    if (this.failT0 > 0) {
      this.failT0--;
      this.events.push("t0-failed");
      throw new Error("valkey unavailable");
    }
    this.events.push("t0");
    this.t0s.push(job);
  }
  async hasT0(subjectType: string, subjectId: string) {
    return this.t0s.some((j) => j.subjectType === subjectType && j.subjectId === subjectId);
  }
  async close() {}
}

/** A fresh evidence keypair (the private half only for tests that open evidence). */
export async function testKeys(): Promise<{ sealer: SealingKey; opener: OpeningKey; publicB64: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const publicB64 = Buffer.from(raw).toString("base64");
  return {
    publicB64,
    sealer: await importSealingKey(publicB64),
    opener: await importOpeningKey(Buffer.from(pkcs8).toString("base64")),
  };
}

/** A logger that keeps every line (log hygiene assertions). */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: createLogger({ service: "test", level: "trace", write: (l) => lines.push(l) }) };
}

/** A database stub for code paths that only read settings and counts. */
export function stubDb(opts: { setting?: unknown; liveCount?: number; fail?: boolean } = {}): Database {
  const result = (rows: unknown[]) => {
    const p: Promise<unknown[]> = opts.fail ? Promise.reject(new Error("database unavailable")) : Promise.resolve(rows);
    // A real promise with the query builder's chaining methods, each returning itself.
    const chain = Object.assign(p, {}) as Promise<unknown[]> & Record<string, () => unknown>;
    for (const m of ["from", "where", "innerJoin", "limit", "groupBy"]) chain[m] = () => chain;
    return chain;
  };
  return {
    select: (fields: Record<string, unknown>) =>
      "value" in fields
        ? result(opts.setting === undefined ? [] : [{ value: opts.setting }])
        : "n" in fields
          ? result([{ n: opts.liveCount ?? 1 }])
          : result([]),
  } as unknown as Database;
}

export async function makeModeration(over: Partial<ModerationDeps> = {}): Promise<{
  moderation: MediaModeration;
  queue: FakeQueue;
  kicks: string[];
  stopped: string[];
  opener: OpeningKey;
  lines: string[];
  events: string[];
}> {
  const { sealer, opener } = await testKeys();
  const queue = over.queue instanceof FakeQueue ? over.queue : new FakeQueue();
  const kicks: string[] = [];
  const stopped: string[] = [];
  const { logger, lines } = captureLogger();
  const events = queue.events;
  const moderation = new MediaModeration({
    db: stubDb(),
    valkey: { set: async () => "OK" },
    queue,
    matcher: fakeMatcher({}),
    sealer,
    tools: fakeTools(),
    kickPublisher: async (p) => {
      kicks.push(p);
      events.push("kick");
    },
    stopBroadcast: async (id) => {
      stopped.push(id);
    },
    logger,
    metrics: createModerationMetrics(),
    envSampleSeconds: 10,
    retry: { initialMs: 1, maxMs: 2 },
    sleep: async () => {},
    ...over,
  });
  return { moderation, queue, kicks, stopped, opener, lines, events };
}
