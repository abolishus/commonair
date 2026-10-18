// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Client address resolution: X-Forwarded-For is honored only from configured trusted proxies. */

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip;
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4?.[1]) {
    const n = ipv4ToBigInt(v4[1]);
    if (n === null) return null;
    addr = `${addr.slice(0, -v4[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

export function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) return null;
  // Treat IPv4-mapped IPv6 as IPv4 so one CIDR list covers both socket families.
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const a = parseIp(ip);
  const b = base ? parseIp(base) : null;
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return a.n >> shift === b.n >> shift;
}

/**
 * Walk X-Forwarded-For from the right, skipping trusted proxies; the first untrusted hop
 * is the client. Without a trusted socket peer the header is ignored entirely.
 */
export function clientIp(socketIp: string, forwardedFor: string | null, trusted: readonly string[]): string {
  const isTrusted = (ip: string) => trusted.some((c) => inCidr(ip, c));
  if (!forwardedFor || !isTrusted(socketIp)) return socketIp;
  const hops = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop && !isTrusted(hop)) return parseIp(hop) ? hop : socketIp;
  }
  return hops[0] && parseIp(hops[0]) ? hops[0] : socketIp;
}

/**
 * A request that came through a proxy we do not trust: it carries X-Forwarded-For but its peer is
 * a private or loopback address that is not in the trusted list. Every client behind such a proxy
 * resolves to the proxy's address and shares one rate-limit subject.
 */
export function looksProxied(socketIp: string, forwardedFor: string | null, trusted: readonly string[]): boolean {
  if (!forwardedFor?.trim()) return false;
  if (trusted.some((c) => inCidr(socketIp, c))) return false;
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "::1/128", "fc00::/7"].some(
    (c) => inCidr(socketIp, c),
  );
}
