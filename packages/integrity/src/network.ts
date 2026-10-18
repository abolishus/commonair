// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Datacenter / hosting-network detection without a proprietary feed (ADR 0003 §8).
 * Operators supply a list of hosting-provider CIDR ranges and, optionally, ASNs, via
 * `INTEGRITY_DATACENTER_CIDRS_FILE`. The API classifies the viewer's address once at
 * session start (it is the only place the raw IP exists) and stores the result in
 * `playback_sessions.asn` / `.datacenter`; scoring reads those columns.
 *
 * File format, one entry per line:
 *   203.0.113.0/24  Example Hosting      # CIDR (IPv4 or IPv6), optional label
 *   2001:db8::/32   Example Cloud
 *   AS64500         Example Transit      # an ASN, optional label
 *   3fff::/20       class=privacy_relay Example Relay   # optional class token before the label
 *   # comment lines and blank lines are ignored
 *
 * Classes: `hosting` (default; servers, VPS, cloud compute) and `privacy_relay` (consumer
 * privacy proxies such as browser or OS relays: real people, so only a weak signal).
 * Privacy-relay matches carry `PRIVACY_RELAY_LABEL_PREFIX` in their label, which is what the
 * API stores in `playback_sessions.datacenter`, so scoring can tell the classes apart from
 * that column alone.
 */
import { readFileSync } from "node:fs";
import { integrityEnv, loadEnv } from "@commonair/config";

export const NETWORK_KINDS = ["hosting", "privacy_relay"] as const;
export type NetworkKind = (typeof NETWORK_KINDS)[number];

/** Prefix of a stored network label that names a privacy relay rather than a hosting provider. */
export const PRIVACY_RELAY_LABEL_PREFIX = "privacy_relay:";

export interface NetworkClassification {
  /** True when the address (or ASN) is on the operator's list (any class). */
  hosting: boolean;
  /** Operator label of the matching range or ASN, e.g. "Example Cloud" (privacy relays are prefixed). */
  label: string | null;
  asn: number | null;
  /** Class of the matching entry; null when nothing matched. */
  kind?: NetworkKind | null;
}

export interface AsnEntry {
  label: string | null;
  kind: NetworkKind;
}

/** Pluggable lookup so operators can swap in their own data source. */
export interface NetworkClassifier {
  classify(ip: string | null, asn?: number | null): NetworkClassification;
}

interface Range {
  family: 4 | 6;
  start: bigint;
  end: bigint;
  label: string | null;
  kind?: NetworkKind;
}

const labelFor = (label: string | null, kind: NetworkKind): string | null =>
  kind === "privacy_relay" ? `${PRIVACY_RELAY_LABEL_PREFIX}${label ?? ""}` : label;

/** Parse an IPv4 or IPv6 address to its family and integer value; null if invalid. */
export function parseIp(input: string): { family: 4 | 6; value: bigint } | null {
  const ip = input.trim();
  const v4 = parseIpv4(ip);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(ip);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffff_ffffn };
  return { family: 6, value: v6 };
}

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    // Decimal only: no octal/hex tricks, no empty parts.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(input: string): bigint | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(":")) return null;
  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) becomes two hextets.
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...rest];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return value;
}

/** Parse `addr/prefix` into an inclusive integer range. */
export function parseCidr(cidr: string): { family: 4 | 6; start: bigint; end: bigint } | null {
  const [addr, prefixText, extra] = cidr.trim().split("/");
  if (!addr || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  // A mapped address with an IPv6-sized prefix is written against the IPv6 space.
  const bits = ip.family === 4 ? 32 : 128;
  let prefix = prefixText === undefined ? bits : Number(prefixText);
  if (ip.family === 4 && addr.includes(":") && prefixText !== undefined) prefix -= 96;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const hostBits = BigInt(bits - prefix);
  const start = (ip.value >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  return { family: ip.family, start, end };
}

/** A classifier backed by an in-memory CIDR + ASN list (binary search over sorted ranges). */
export class CidrClassifier implements NetworkClassifier {
  private readonly ranges: Range[];
  /** Running maximum of `end` so overlapping ranges are still found by binary search. */
  private readonly maxEnd: bigint[];
  private readonly asns: Map<number, AsnEntry>;

  constructor(ranges: readonly Range[], asns: ReadonlyMap<number, string | null | AsnEntry> = new Map()) {
    this.ranges = [...ranges].sort(
      (a, b) => a.family - b.family || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
    );
    this.maxEnd = [];
    let max = -1n;
    let family = 0;
    for (const r of this.ranges) {
      if (r.family !== family) {
        family = r.family;
        max = -1n;
      }
      if (r.end > max) max = r.end;
      this.maxEnd.push(max);
    }
    this.asns = new Map(
      [...asns].map(([n, v]) => [n, v !== null && typeof v === "object" ? v : { label: v, kind: "hosting" }]),
    );
  }

  get size(): number {
    return this.ranges.length + this.asns.size;
  }

  classify(ip: string | null, asn: number | null = null): NetworkClassification {
    const byAsn = asn === null ? undefined : this.asns.get(asn);
    if (byAsn) return { hosting: true, label: labelFor(byAsn.label, byAsn.kind), asn, kind: byAsn.kind };
    const parsed = ip ? parseIp(ip) : null;
    if (parsed) {
      const hit = this.find(parsed.family, parsed.value);
      if (hit) {
        const kind = hit.kind ?? "hosting";
        return { hosting: true, label: labelFor(hit.label, kind), asn, kind };
      }
    }
    return { hosting: false, label: null, asn, kind: null };
  }

  private find(family: 4 | 6, value: bigint): Range | null {
    // Last range (in sort order) with start <= value.
    let lo = 0;
    let hi = this.ranges.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid]!;
      if (r.family < family || (r.family === family && r.start <= value)) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = idx; i >= 0; i--) {
      const r = this.ranges[i]!;
      if (r.family !== family || this.maxEnd[i]! < value) break;
      if (r.start <= value && value <= r.end) return r;
    }
    return null;
  }
}

export interface ParseResult {
  classifier: CidrClassifier;
  /** 1-based line numbers that could not be parsed (reported, never fatal). */
  invalidLines: number[];
}

/** Parse the operator file format described at the top of this module. */
export function parseNetworkList(text: string): ParseResult {
  const ranges: Range[] = [];
  const asns = new Map<number, AsnEntry>();
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const [entry, ...rest] = line.split(/\s+/);
    let kind: NetworkKind = "hosting";
    const classMatch = /^class=(.*)$/.exec(rest[0] ?? "");
    if (classMatch) {
      const k = NETWORK_KINDS.find((n) => n === classMatch[1]);
      if (!k) {
        invalidLines.push(i + 1);
        return;
      }
      kind = k;
      rest.shift();
    }
    const label = rest.join(" ") || null;
    const asMatch = /^AS(\d{1,10})$/i.exec(entry ?? "");
    if (asMatch) {
      const n = Number(asMatch[1]);
      if (n <= 4_294_967_295) {
        asns.set(n, { label, kind });
        return;
      }
    }
    const cidr = entry ? parseCidr(entry) : null;
    if (cidr) ranges.push({ ...cidr, label, kind });
    else invalidLines.push(i + 1);
  });
  return { classifier: new CidrClassifier(ranges, asns), invalidLines };
}

/** Load a list file; throws if the file cannot be read (a misconfigured path must not pass silently). */
export function loadNetworkList(path: string): ParseResult {
  return parseNetworkList(readFileSync(path, "utf8"));
}

/** Classifier configured by `INTEGRITY_DATACENTER_CIDRS_FILE`, or one that matches nothing when unset. */
export function classifierFromEnv(source: Record<string, string | undefined> = process.env): ParseResult {
  const env = loadEnv(integrityEnv, source);
  if (!env.INTEGRITY_DATACENTER_CIDRS_FILE) return { classifier: new CidrClassifier([]), invalidLines: [] };
  return loadNetworkList(env.INTEGRITY_DATACENTER_CIDRS_FILE);
}

/** Path of the bundled sample list (harness and development only; not a real feed). */
export const SAMPLE_HOSTING_CIDRS_FILE = new URL("../data/sample-hosting-cidrs.txt", import.meta.url).pathname;
