// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulcast targets are user-supplied URLs the media host connects to, so they are an SSRF
 * vector: only `rtmp:`/`rtmps:` URLs whose host resolves exclusively to public unicast
 * addresses are allowed. The check runs on the resolved addresses (not the host string), and
 * the caller connects to the vetted address itself, so DNS rebinding between check and connect
 * cannot redirect the stream to an internal service.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const SIMULCAST_PROTOCOLS = ["rtmp:", "rtmps:"] as const;
const DEFAULT_PORTS: Record<string, number> = { "rtmp:": 1935, "rtmps:": 443 };

/** Stable reasons; never shown verbatim to users (they get a generic message). */
export type TargetRejection = "invalid_url" | "protocol_not_allowed" | "credentials_in_url" | "address_not_allowed";

export class TargetNotAllowedError extends Error {
  constructor(
    readonly reason: TargetRejection,
    detail: string,
  ) {
    super(`simulcast target not allowed (${reason}): ${detail}`);
    this.name = "TargetNotAllowedError";
  }
}

export interface ParsedTarget {
  protocol: "rtmp:" | "rtmps:";
  /** Host name or IP literal, without IPv6 brackets. */
  host: string;
  port: number;
  /** RTMP application: the first path segment plus any query (how ffmpeg splits a URL). */
  app: string;
  /** Remaining path segments, prepended to the stream key as the RTMP play path. */
  playpathPrefix: string;
  /** `rtmp[s]://host[:port]/app` without any secret, sent as the RTMP `tcUrl`. */
  tcUrl: string;
}

/** Validate the URL shape (protocol whitelist, no credentials) and split it the way RTMP needs. */
export function parseTargetUrl(raw: string): ParsedTarget {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new TargetNotAllowedError("invalid_url", "unparseable");
  }
  const protocol = u.protocol.toLowerCase();
  if (protocol !== "rtmp:" && protocol !== "rtmps:") throw new TargetNotAllowedError("protocol_not_allowed", protocol);
  if (u.username || u.password) throw new TargetNotAllowedError("credentials_in_url", "userinfo present");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new TargetNotAllowedError("invalid_url", "no host");
  const port = u.port ? Number(u.port) : (DEFAULT_PORTS[protocol] ?? 1935);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TargetNotAllowedError("invalid_url", "bad port");
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  const app = (segments[0] ?? "") + u.search;
  const playpathPrefix = segments.slice(1).join("/");
  const hostPart = host.includes(":") ? `[${host}]` : host;
  const tcUrl = `${protocol}//${hostPart}${u.port ? `:${port}` : ""}/${app}`;
  return { protocol, host, port, app, playpathPrefix, tcUrl };
}

type Cidr4 = readonly [number, number];
/** IPv4 ranges that are never a legitimate public RTMP ingest. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];
const V4_RANGES: Cidr4[] = BLOCKED_V4.map(([a, bits]) => [v4ToInt(a) ?? 0, bits]);

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function v4Blocked(n: number): boolean {
  return V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/** Eight 16-bit groups, or null if not a valid IPv6 literal (embedded dotted IPv4 allowed). */
export function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    // Rewrite a trailing dotted IPv4 (`::ffff:127.0.0.1`) as two hex groups.
    const v4 = v4ToInt(last);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const have = head.length + rest.length;
  if (halves.length === 1 ? have !== 8 : have > 7) return null;
  const zeros = halves.length === 2 ? 8 - have : 0;
  return [...head, ...Array<string>(zeros).fill("0"), ...rest].map((g) => parseInt(g, 16));
}

function v6Blocked(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = ((g6 << 16) >>> 0) + g7;
  const allZero = (xs: number[]) => xs.every((x) => x === 0);
  // ::/128 unspecified, ::1 loopback, ::/96 IPv4-compatible (deprecated): none are public.
  if (allZero([g0, g1, g2, g3, g4, g5])) return true;
  // ::ffff:0:0/96 IPv4-mapped and ::ffff:0:0:0/96 IPv4-translated: judge the embedded IPv4.
  if (allZero([g0, g1, g2, g3, g4]) && g5 === 0xffff) return v4Blocked(embedded);
  if (allZero([g0, g1, g2, g3]) && g4 === 0xffff && g5 === 0) return v4Blocked(embedded);
  // 64:ff9b::/96 NAT64 (well-known): the embedded IPv4; 64:ff9b:1::/48 local-use NAT64: blocked.
  if (g0 === 0x64 && g1 === 0xff9b && allZero([g2, g3, g4, g5])) return v4Blocked(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x100 && allZero([g1, g2, g3])) return true; // 100::/64 discard
  if (g0 === 0x2001 && g1 < 0x200) return true; // 2001::/23 IETF special (Teredo, ORCHID, …)
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x2002) return v4Blocked(((g1 << 16) >>> 0) + g2); // 6to4: embedded IPv4
  if (g0 === 0x3fff && g1 < 0x1000) return true; // 3fff::/20 documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. AWS fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when `ip` is a literal address that a simulcast target must never resolve to. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip.replace(/%.*$/, ""));
  if (family === 4) {
    const n = v4ToInt(ip);
    return n === null || v4Blocked(n);
  }
  if (family === 6) {
    const g = expandV6(ip);
    return g === null || v6Blocked(g);
  }
  // Not an IP literal: refuse rather than guess.
  return true;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) => {
  const all = await lookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface ResolveOptions {
  /** Dev/test only: allow loopback and private targets (a local mock RTMP server). */
  allowPrivate?: boolean;
  resolver?: Resolver;
}

/**
 * Resolve the target host and return an address to connect to. Every resolved address must be
 * public: a name that resolves to both a public and an internal address is refused outright.
 */
export async function resolveTarget(target: ParsedTarget, opts: ResolveOptions = {}): Promise<ResolvedAddress> {
  const literal = isIP(target.host);
  const addrs: ResolvedAddress[] = literal
    ? [{ address: target.host, family: literal === 6 ? 6 : 4 }]
    : await (opts.resolver ?? systemResolver)(target.host);
  if (addrs.length === 0) throw new TargetNotAllowedError("address_not_allowed", "no addresses");
  if (!opts.allowPrivate) {
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) throw new TargetNotAllowedError("address_not_allowed", "resolves to a non-public address");
  }
  return addrs[0] as ResolvedAddress;
}
