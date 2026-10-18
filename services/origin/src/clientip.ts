// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client address resolution (honouring `X-Forwarded-For` only from TRUSTED_PROXY_CIDRS)
 * and an in-process limiter for failed authentication attempts. Addresses are kept in
 * memory only, never logged or persisted.
 */

interface Ip {
  v: 4 | 6;
  n: bigint;
}
export interface Cidr extends Ip {
  bits: number;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseV6(s: string): bigint | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): string[] | null => {
    if (h === "") return [];
    const g = h.split(":");
    const last = g.at(-1) ?? "";
    if (last.includes(".")) {
      const v4 = parseV4(last);
      if (v4 === null) return null;
      g.splice(-1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
    }
    return g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? g : null;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  let n = 0n;
  for (const g of [...head, ...Array<string>(missing).fill("0"), ...tail])
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  return n;
}

export function parseIp(raw: string): Ip | null {
  const s =
    raw
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

export function parseCidr(raw: string): Cidr | null {
  const [addr, len] = raw.trim().split("/");
  const ip = parseIp(addr ?? "");
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { ...ip, bits };
}

export function inCidrs(ip: Ip, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => {
    if (c.v !== ip.v) return false;
    const shift = BigInt((ip.v === 4 ? 32 : 128) - c.bits);
    return ip.n >> shift === c.n >> shift;
  });
}

/**
 * The client's address: the peer, unless the peer is a trusted proxy, in which case the
 * right-most `X-Forwarded-For` entry that is not itself a trusted proxy.
 */
export function clientIp(peer: string | undefined, xff: string | null, trusted: Cidr[]): string | undefined {
  const p = peer ? parseIp(peer) : null;
  if (!p || !xff || !inCidrs(p, trusted)) return peer;
  const hops = xff.split(",").map((h) => h.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i] ?? "");
    if (!hop) return peer;
    if (!inCidrs(hop, trusted)) return hops[i];
  }
  return peer;
}

/** Fixed-window counter of failures per key; blocks a key after `max` failures in `windowMs`. */
export class FailureLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const w = this.windows.get(key);
    if (!w) return false;
    if (this.now() - w.start >= this.windowMs) {
      this.windows.delete(key);
      return false;
    }
    return w.count >= this.max;
  }

  fail(key: string): void {
    const t = this.now();
    const w = this.windows.get(key);
    if (w && t - w.start < this.windowMs) {
      w.count++;
      return;
    }
    this.windows.delete(key);
    this.windows.set(key, { start: t, count: 1 });
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
