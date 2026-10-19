// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Offers this socket's session sent that the tracker relayed, awaiting the receiver's answer.
 * An exchange completes only when the session the offer was relayed to answers with the same
 * `offer_id` in the same swarm within the timeout (ADR 0005, `KEYS.p2pLinks`). Answers to offers
 * the tracker never relayed, or from another session, complete nothing.
 */
import { P2P_EVIDENCE } from "@commonair/contracts/internal";

export const MAX_PENDING_EXCHANGES = 100;

interface Pending {
  toSid: string;
  swarm: string;
  at: number;
}

export class PendingExchanges {
  /** offer_id → relay; Map order is insertion order, so the first entry is the oldest. */
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs: number = P2P_EVIDENCE.exchangeTimeoutMs,
    private readonly max: number = MAX_PENDING_EXCHANGES,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /** The tracker relayed this session's offer `offerId` to session `toSid`. */
  add(offerId: string, toSid: string, swarm: string, now: number): void {
    // Re-insert so a reused offer id counts as the newest.
    this.pending.delete(offerId);
    this.pending.set(offerId, { toSid, swarm, at: now });
    while (this.pending.size > this.max) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      this.pending.delete(oldest.value);
    }
  }

  /**
   * Session `fromSid` answered `offerId` in `swarm`. True (and consumed) when that matches a
   * relay made within the timeout; a mismatch leaves the pending entry for the right answerer.
   */
  complete(offerId: string, fromSid: string, swarm: string, now: number): boolean {
    const p = this.pending.get(offerId);
    if (!p) return false;
    if (now - p.at > this.timeoutMs) {
      this.pending.delete(offerId);
      return false;
    }
    if (p.toSid !== fromSid || p.swarm !== swarm) return false;
    this.pending.delete(offerId);
    return true;
  }
}
