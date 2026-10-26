// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Counting an observable side effect per item (an outbox event on the bus, a chat message in
 * history) to tell exactly-once from lost or repeated. Pure.
 */

export interface DeliverySummary {
  expected: number;
  /** Distinct expected keys seen at least once. */
  delivered: number;
  /** Expected keys never seen. */
  missing: string[];
  /** Expected keys seen more than once, with their counts. */
  duplicated: { key: string; count: number }[];
  /** Total extra deliveries (Σ count − 1 over duplicated keys). */
  extra: number;
  /** Keys seen that were not expected (another run, or a bug in the producer). */
  unexpected: number;
}

export class DeliveryCounter {
  private readonly counts = new Map<string, number>();
  private readonly firstAt = new Map<string, number>();

  record(key: string, at = Date.now()): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!this.firstAt.has(key)) this.firstAt.set(key, at);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** When `key` was first seen (epoch ms), or null. */
  seenAt(key: string): number | null {
    return this.firstAt.get(key) ?? null;
  }

  /** How many of `keys` have been seen at least once. */
  seen(keys: Iterable<string>): number {
    let n = 0;
    for (const k of keys) if (this.counts.has(k)) n++;
    return n;
  }

  summary(expected: Iterable<string>, sampleLimit = 20): DeliverySummary {
    return summarizeDeliveries(this.counts, expected, sampleLimit);
  }
}

export function summarizeDeliveries(
  counts: ReadonlyMap<string, number>,
  expected: Iterable<string>,
  sampleLimit = 20,
): DeliverySummary {
  const want = new Set(expected);
  const missing: string[] = [];
  const duplicated: { key: string; count: number }[] = [];
  let delivered = 0;
  let extra = 0;
  for (const key of want) {
    const n = counts.get(key) ?? 0;
    if (n === 0) missing.push(key);
    else delivered++;
    if (n > 1) {
      duplicated.push({ key, count: n });
      extra += n - 1;
    }
  }
  let unexpected = 0;
  for (const key of counts.keys()) if (!want.has(key)) unexpected++;
  return {
    expected: want.size,
    delivered,
    missing: missing.slice(0, sampleLimit),
    duplicated: duplicated.slice(0, sampleLimit),
    extra,
    unexpected,
  };
}

/** Exactly once: every expected key seen, none twice. */
export const exactlyOnce = (s: DeliverySummary): boolean => s.missing.length === 0 && s.extra === 0;

/**
 * After a worker is killed mid-batch, the rows it had claimed roll back and are relayed again:
 * the outbox is at-least-once by design (services/worker/src/outbox.ts), so at most one batch
 * per killed worker may repeat. Nothing may be lost.
 */
export function withinOneBatch(s: DeliverySummary, batchSize: number, killedWorkers = 1): boolean {
  return s.missing.length === 0 && s.extra <= batchSize * killedWorkers;
}

/** Whether every sender's messages arrive in the order that sender sent them. */
export function perSenderOrderKept(
  received: readonly { sender: string; key: string }[],
  sent: ReadonlyMap<string, readonly string[]>,
): boolean {
  for (const [sender, keys] of sent) {
    const order = received.filter((r) => r.sender === sender && keys.includes(r.key)).map((r) => r.key);
    const expectedOrder = keys.filter((k) => order.includes(k));
    if (order.length !== expectedOrder.length || order.some((k, i) => k !== expectedOrder[i])) return false;
  }
  return true;
}
