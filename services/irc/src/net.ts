// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client address handling for connection caps. A forwarded address
 * (`X-Forwarded-For`, WebSocket only) is trusted only when the direct peer is
 * inside TRUSTED_PROXY_CIDRS; otherwise any client could pick its own IP and
 * dodge the per-IP limits.
 */

interface Parsed {
  value: bigint;
  bits: 32 | 128;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(s: string): bigint | null {
  let str = s;
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    str = `${str.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** Parse an IP; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalized to IPv4. */
export function parseIp(raw: string): Parsed | null {
  const s = raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  const v4 = parseV4(s);
  if (v4 !== null) return { value: v4, bits: 32 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { value: v6 & 0xffffffffn, bits: 32 };
  return { value: v6, bits: 128 };
}

export interface Cidr {
  value: bigint;
  bits: 32 | 128;
  prefix: number;
}

export function parseCidr(raw: string): Cidr | null {
  const [addr = "", len] = raw.trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  // A mapped-v4 CIDR like ::ffff:10.0.0.0/104 is expressed in v6 bits.
  const v6Mapped = ip.bits === 32 && addr.includes(":");
  let prefix = len === undefined ? ip.bits : Number(len);
  if (v6Mapped && len !== undefined) prefix -= 96;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return null;
  return { value: ip.value, bits: ip.bits, prefix };
}

export function inCidr(ip: Parsed, cidr: Cidr): boolean {
  if (ip.bits !== cidr.bits) return false;
  const shift = BigInt(cidr.bits - cidr.prefix);
  return ip.value >> shift === cidr.value >> shift;
}

/** Canonical string key for an address (so `::ffff:1.2.3.4` and `1.2.3.4` count together). */
export function ipKey(raw: string): string {
  const ip = parseIp(raw);
  if (!ip) return raw;
  if (ip.bits === 32) return [24n, 16n, 8n, 0n].map((s) => String((ip.value >> s) & 0xffn)).join(".");
  return ip.value
    .toString(16)
    .padStart(32, "0")
    .replace(/(.{4})(?!$)/g, "$1:");
}

/**
 * The client address: the direct peer, unless it is a trusted proxy, in which case
 * the right-most `X-Forwarded-For` entry that is not itself a trusted proxy.
 */
export function clientAddress(peer: string, forwardedFor: string | null, trusted: readonly Cidr[]): string {
  const isTrusted = (a: string) => {
    const ip = parseIp(a);
    return ip !== null && trusted.some((c) => inCidr(ip, c));
  };
  if (!forwardedFor || !isTrusted(peer)) return ipKey(peer);
  const hops = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let last = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] ?? "";
    if (parseIp(hop) === null) break; // garbage: stop at the last address we can vouch for
    if (!isTrusted(hop)) return ipKey(hop);
    last = hop;
  }
  return ipKey(last);
}
