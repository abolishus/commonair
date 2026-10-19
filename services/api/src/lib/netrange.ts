// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Address classification for outbound-URL checks (SSRF) and rate-limit subjects. */
import { inCidr, parseIp } from "./ip.ts";

/**
 * Not globally routable, or routable only to infrastructure we must never reach from a
 * user-supplied URL: private, loopback, link-local (incl. cloud metadata), CGNAT, multicast,
 * documentation, benchmarking, reserved, and IPv6 transition ranges that can tunnel to them.
 */
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const BLOCKED_V6 = [
  "::/96", // unspecified, loopback and deprecated IPv4-compatible
  "64:ff9b::/96", // NAT64: can reach any IPv4, including private
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32", // Teredo
  "2001:2::/48",
  "2001:db8::/32",
  "2002::/16", // 6to4
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

/** True only for a syntactically valid, globally routable unicast address. */
export function isPublicAddress(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  // parseIp folds IPv4-mapped IPv6 (::ffff:a.b.c.d) into IPv4, so one list covers both.
  const list = parsed.v === 4 ? BLOCKED_V4 : BLOCKED_V6;
  return !list.some((cidr) => inCidr(ip, cidr));
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
    // Strictly longer wins, so the first of equal runs is the one compressed.
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = (gs: number[]) => gs.map((g) => g.toString(16)).join(":");
  if (best.len < 2) return hex(groups);
  return `${hex(groups.slice(0, best.at))}::${hex(groups.slice(best.at + best.len))}`;
}

/**
 * One spelling per address, so the same client hashes the same way on every path (playback
 * `ip_hash`, rate limits, `stream_keys.last_used_ip_hash`; integrity compares them): IPv4-mapped
 * IPv6 becomes IPv4, IPv6 is RFC 5952 (lower-case, compressed), zone ids and brackets are
 * dropped. Unparseable input is returned trimmed and lower-cased.
 */
export function canonicalIp(ip: string): string {
  const raw = ip.trim().replace(/^\[(.*)\]$/, "$1");
  const parsed = parseIp(raw);
  if (!parsed) return raw.toLowerCase();
  return parsed.v === 4 ? v4String(parsed.n) : v6String(parsed.n);
}

/**
 * The rate-limit subject for an address: IPv4 as is, IPv6 by its /64 (one subscriber usually
 * holds a whole /64, so per-address limits are trivially bypassed). Unparseable input is
 * returned unchanged.
 */
export function rateLimitSubjectIp(ip: string): string {
  const parsed = parseIp(ip);
  if (!parsed) return ip;
  if (parsed.v === 4) return v4String(parsed.n);
  const prefix = parsed.n >> 64n;
  const groups = [48n, 32n, 16n, 0n].map((s) => ((prefix >> s) & 0xffffn).toString(16));
  return `${groups.join(":")}::/64`;
}
