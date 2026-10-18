// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Connection admission: a global cap, a per-IP cap, and a per-IP rate of new
 * connections. Every connection costs an upstream WebSocket, so these protect
 * the chat service as much as the gateway.
 */
import { TokenBucket } from "./ratelimit.ts";

export interface ConnectionLimits {
  maxConnections: number;
  maxPerIp: number;
  /** New connections per IP: burst, then sustained per second. */
  connectBurstPerIp: number;
  connectPerSecondPerIp: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxConnections: 20_000,
  maxPerIp: 50,
  connectBurstPerIp: 20,
  connectPerSecondPerIp: 2,
};

export type Refusal = "server_full" | "too_many_from_ip" | "connecting_too_fast";

/** Buckets idle this long are full again and can be forgotten. */
const BUCKET_IDLE_MS = 5 * 60_000;

export class Admission {
  private total = 0;
  private readonly perIp = new Map<string, number>();
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(
    readonly limits: ConnectionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.sweep = setInterval(() => this.forgetIdle(), 60_000);
    this.sweep.unref();
  }

  /** Admit a connection from `ip`, counting it; null when admitted. */
  admit(ip: string): Refusal | null {
    if (this.total >= this.limits.maxConnections) return "server_full";
    if ((this.perIp.get(ip) ?? 0) >= this.limits.maxPerIp) return "too_many_from_ip";
    let entry = this.buckets.get(ip);
    if (!entry) {
      entry = {
        bucket: new TokenBucket(this.limits.connectBurstPerIp, this.limits.connectPerSecondPerIp, this.now),
        lastUsed: 0,
      };
      this.buckets.set(ip, entry);
    }
    entry.lastUsed = this.now();
    if (!entry.bucket.take()) return "connecting_too_fast";
    this.total++;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    return null;
  }

  release(ip: string): void {
    const n = this.perIp.get(ip) ?? 0;
    if (n <= 0) return;
    this.total--;
    if (n === 1) this.perIp.delete(ip);
    else this.perIp.set(ip, n - 1);
  }

  connectionsFrom(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  forgetIdle(): void {
    const cutoff = this.now() - BUCKET_IDLE_MS;
    for (const [ip, e] of this.buckets) if (e.lastUsed < cutoff) this.buckets.delete(ip);
  }

  stop(): void {
    clearInterval(this.sweep);
  }
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  server_full: "Server full",
  too_many_from_ip: "Too many connections from your address",
  connecting_too_fast: "Reconnecting too fast",
};
