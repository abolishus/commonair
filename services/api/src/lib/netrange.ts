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

/**
 * The rate-limit subject for an address: IPv4 as is, IPv6 by its /64 (one subscriber usually
 * holds a whole /64, so per-address limits are trivially bypassed). Unparseable input is
 * returned unchanged.
 */
export function rateLimitSubjectIp(ip: string): string {
  const parsed = parseIp(ip);
  if (!parsed) return ip;
  if (parsed.v === 4) {
    const n = Number(parsed.n);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  const prefix = parsed.n >> 64n;
  const groups = [48n, 32n, 16n, 0n].map((s) => ((prefix >> s) & 0xffffn).toString(16));
  return `${groups.join(":")}::/64`;
}
