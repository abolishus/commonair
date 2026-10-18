// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSRF protection for webhook callbacks. A callback is resolved once, every
 * resolved address must be public, and the request then connects to that exact
 * address (see http.ts), so a DNS answer that changes between check and connect
 * (rebinding) cannot redirect us into the private network.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressClass =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "documentation"
  | "invalid";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const all = await lookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Dotted-quad only: URL parsing has already normalized decimal/octal/hex host forms. */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, accepting `::` compression and an embedded dotted IPv4 tail. */
function parseIpv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return null;
  if (ip.slice(lastColon + 1).includes(".")) {
    // Rewrite a dotted IPv4 tail as two hex groups so the rest is plain hex parsing.
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    ip = `${ip.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest];
}

function classifyV4(o: number[]): AddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = o;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "shared";
  if (a === 169 && b === 254) return c === 169 && d === 254 ? "metadata" : "link-local";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
    return "documentation";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

const v4FromGroups = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function classifyV6(g: number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 0) return "unspecified";
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d, deprecated) and IPv4-translated (::ffff:0:a.b.c.d).
  if (zeroHead && g5 === 0xffff) return classifyV4(v4FromGroups(g6, g7));
  if (zeroHead && g5 === 0) return classifyV4(v4FromGroups(g6, g7));
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0)
    return classifyV4(v4FromGroups(g6, g7));
  // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48) prefixes embed an IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b) return classifyV4(v4FromGroups(g6, g7));
  // 6to4 embeds the IPv4 address in groups 1–2.
  if (g0 === 0x2002) return classifyV4(v4FromGroups(g1, g2));
  if (g0 === 0x2001 && g1 === 0) return "reserved"; // Teredo: the real endpoint is obfuscated.
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation";
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "reserved"; // discard-only 100::/64
  if ((g0 & 0xfe00) === 0xfc00) return g0 === 0xfd00 && g1 === 0xec2 ? "metadata" : "private"; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xffc0) === 0xfec0) return "private"; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if ((g0 & 0xe000) !== 0x2000) return "reserved"; // only 2000::/3 is global unicast
  return "public";
}

/** Classify an IP literal (IPv4 dotted-quad or IPv6, with or without brackets). */
export function classifyAddress(input: string): AddressClass {
  const ip = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (ip.includes(":")) {
    const g = parseIpv6(ip);
    return g ? classifyV6(g) : "invalid";
  }
  const o = parseIpv4(ip);
  return o ? classifyV4(o) : "invalid";
}

export class CallbackRejected extends Error {
  constructor(public readonly reason: string) {
    super(`callback rejected: ${reason}`);
    this.name = "CallbackRejected";
  }
}

export interface PinnedTarget {
  url: URL;
  /** Bare hostname (no brackets): used for the Host header and TLS SNI. */
  hostname: string;
  address: ResolvedAddress;
}

/**
 * Validate a callback URL and pin the address to connect to. With `allowInsecure`
 * http:// and private addresses are accepted (local harness receivers), but the
 * address is still pinned.
 */
export async function resolveCallback(
  raw: string,
  opts: { allowInsecure: boolean; resolve?: Resolver },
): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackRejected("invalid URL");
  }
  if (url.protocol !== "https:" && !(opts.allowInsecure && url.protocol === "http:"))
    throw new CallbackRejected(opts.allowInsecure ? "scheme must be http or https" : "scheme must be https");
  if (url.username || url.password) throw new CallbackRejected("credentials in URL");
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname) throw new CallbackRejected("missing host");

  let addresses: ResolvedAddress[];
  const literal = isIP(hostname);
  if (literal) addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await (opts.resolve ?? systemResolver)(hostname);
    } catch {
      throw new CallbackRejected("host does not resolve");
    }
  }
  if (addresses.length === 0) throw new CallbackRejected("host does not resolve");
  if (!opts.allowInsecure) {
    // Every answer must be public: a mixed answer set is a classic rebinding setup.
    for (const a of addresses) {
      const cls = classifyAddress(a.address);
      if (cls !== "public") throw new CallbackRejected(`address is ${cls}`);
    }
  }
  const address = addresses[0];
  if (!address) throw new CallbackRejected("host does not resolve");
  return { url, hostname, address };
}
