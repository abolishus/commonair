// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payout-transfer producer (money/transfers.ts) against the real Valkey: one BullMQ job per
 * payout under `payoutTransferJobId` with the transfer's attempts and backoff, nothing for an empty
 * list, one producer per deps created on first use, and `startPayoutTransfers` never throwing when
 * the queue cannot be reached (the run stands; the next run picks the payouts up again).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { B8_JOBS, QUEUES, payoutTransferJobId } from "@commonair/contracts/internal";
import { PAYOUT_TRANSFER_ATTEMPTS, PAYOUT_TRANSFER_BACKOFF_MS } from "@commonair/ledger";
import {
  closePayoutTransferQueue,
  createPayoutTransferQueue,
  payoutTransferQueue,
  setPayoutTransferQueue,
  startPayoutTransfers,
} from "../src/money/transfers.ts";
import { startApi, type TestApi } from "./harness.ts";

let api: TestApi;
const prefix = `test-payout-transfers-${crypto.randomUUID()}`;
let conn: Valkey;
let reader: Queue;
beforeAll(async () => {
  api = await startApi({ env: { WORKER_BULL_PREFIX: prefix } });
  conn = new Valkey(api.deps.env.VALKEY_URL, { maxRetriesPerRequest: null });
  reader = new Queue(QUEUES.payments, { connection: conn, prefix });
}, 60_000);
afterAll(async () => {
  await reader?.obliterate({ force: true }).catch(() => undefined);
  await reader?.close();
  conn?.disconnect();
  if (api) await closePayoutTransferQueue(api.deps);
  await api?.stop();
});

describe("the payout-transfer producer", () => {
  test("one job per payout, under its job id, with the transfer's attempts and backoff", async () => {
    const q = createPayoutTransferQueue(api.deps.env.VALKEY_URL, prefix);
    try {
      await q.enqueue([]);
      expect(await reader.getJobCounts("waiting")).toEqual({ waiting: 0 });
      const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
      await q.enqueue([a, b]);
      // A payout queued again while its job waits is still one job.
      await q.enqueue([a]);
      const job = await reader.getJob(payoutTransferJobId(a));
      expect(job?.name).toBe(B8_JOBS.payoutTransfers);
      expect(job?.data).toEqual({ payoutId: a });
      expect(job?.opts.attempts).toBe(PAYOUT_TRANSFER_ATTEMPTS);
      expect(job?.opts.backoff).toEqual({ type: "exponential", delay: PAYOUT_TRANSFER_BACKOFF_MS });
      expect(await reader.getJob(payoutTransferJobId(b))).toBeDefined();
      expect((await reader.getJobCounts("waiting")).waiting).toBe(2);
    } finally {
      await q.close();
      await reader.drain();
    }
  });

  test("one producer per deps, made on first use on the worker's prefix; closing forgets it", async () => {
    const first = payoutTransferQueue(api.deps);
    expect(payoutTransferQueue(api.deps)).toBe(first);
    const id = crypto.randomUUID();
    await first.enqueue([id]);
    expect(await reader.getJob(payoutTransferJobId(id))).toBeDefined();
    await closePayoutTransferQueue(api.deps);
    expect(payoutTransferQueue(api.deps)).not.toBe(first);
    await closePayoutTransferQueue(api.deps);
    // Closing twice (nothing left) is harmless.
    await closePayoutTransferQueue(api.deps);
    await reader.drain();
  });

  test("startPayoutTransfers: nothing with the manual adapter; a queue failure is logged, never thrown", async () => {
    expect(await startPayoutTransfers(api.deps)).toEqual({ scheduled: 0, enqueued: 0 });
    const env = api.deps.env as unknown as Record<string, unknown>;
    const saved = { p: env.PAYMENTS_PROVIDER, k: env.STRIPE_SECRET_KEY };
    Object.assign(env, { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_queue" });
    let asked = 0;
    setPayoutTransferQueue(api.deps, {
      enqueue: () => {
        asked += 1;
        return Promise.reject(new Error("valkey down"));
      },
      close: () => Promise.resolve(),
    });
    try {
      expect(await startPayoutTransfers(api.deps)).toEqual({ scheduled: 0, enqueued: 0 });
      expect(asked).toBe(1);
      // A Stripe instance without a usable key cannot transfer: also nothing, also no throw.
      env.STRIPE_SECRET_KEY = "";
      expect(await startPayoutTransfers(api.deps)).toEqual({ scheduled: 0, enqueued: 0 });
      expect(asked).toBe(1);
    } finally {
      Object.assign(env, { PAYMENTS_PROVIDER: saved.p, STRIPE_SECRET_KEY: saved.k });
      await closePayoutTransferQueue(api.deps);
    }
  });
});
