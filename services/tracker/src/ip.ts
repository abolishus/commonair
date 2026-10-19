// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client address resolution and network prefixes.
 *
 * `parseIp`, `inCidr`, `clientIp` and `canonicalIp` are copied from services/api/src/lib/ip.ts
 * and services/api/src/lib/netrange.ts so the tracker resolves and spells addresses exactly as
 * the API does (contract request: move them into @commonair/service). `networkPrefix` is the
 * tracker's own.
 */

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

/** True when `cidr` is an address or address/bits the matcher understands. */
export function isValidCidr(cidr: string): boolean {
  const [base, bitsRaw, extra] = cidr.split("/");
  if (extra !== undefined || !base) return false;
  const a = parseIp(base);
  if (!a) return false;
  if (bitsRaw === undefined) return true;
  const bits = Number(bitsRaw);
  return /^\d+$/.test(bitsRaw) && bits >= 0 && bits <= (a.v === 4 ? 32 : 128);
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

const v4String = (n: bigint) => {
  const x = Number(n);
  return [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
};

/** RFC 5952 text form: lower-case, no leading zeros, the longest run (2+) of zero groups as "::". */
function v6String(n: bigint): string {
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => Number((n >> s) & 0xffffn));
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = (gs: number[]) => gs.map((g) => g.toString(16)).join(":");
  if (best.len < 2) return hex(groups);
  return `${hex(groups.slice(0, best.at))}::${hex(groups.slice(best.at + best.len))}`;
}

/**
 * One spelling per address: IPv4-mapped IPv6 becomes IPv4, IPv6 is RFC 5952, zone ids and
 * brackets are dropped. Unparseable input is returned trimmed and lower-cased.
 */
export function canonicalIp(ip: string): string {
  const raw = ip.trim().replace(/^\[(.*)\]$/, "$1");
  const parsed = parseIp(raw);
  if (!parsed) return raw.toLowerCase();
  return parsed.v === 4 ? v4String(parsed.n) : v6String(parsed.n);
}

/**
 * Subject of the per-address connection limit: the address for IPv4, its /64 for IPv6 (one
 * subscriber usually holds a whole /64, so per-address limits would be trivially sidestepped).
 * Unparseable input is returned canonicalised.
 */
export function connectionKey(ip: string): string {
  const parsed = parseIp(ip.trim().replace(/^\[(.*)\]$/, "$1"));
  if (!parsed) return canonicalIp(ip);
  if (parsed.v === 4) return v4String(parsed.n);
  const mask = ((1n << 64n) - 1n) << 64n;
  return `${v6String(parsed.n & mask)}/64`;
}

/**
 * The network an address belongs to for P2P evidence: its /24 (IPv4) or /48 (IPv6) in canonical
 * form, e.g. `203.0.113.0/24`, `2001:db8:1::/48`. IPv4-mapped IPv6 counts as IPv4. Unparseable
 * input yields null.
 */
export function networkPrefix(ip: string): string | null {
  const parsed = parseIp(ip.trim().replace(/^\[(.*)\]$/, "$1"));
  if (!parsed) return null;
  if (parsed.v === 4) return `${v4String(parsed.n & 0xffffff00n)}/24`;
  const mask = ((1n << 48n) - 1n) << 80n;
  return `${v6String(parsed.n & mask)}/48`;
}
