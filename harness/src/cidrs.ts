// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** IPv4 CIDR lists: parse, test membership, and pick simulated client addresses. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Cidr {
  text: string;
  base: number;
  prefix: number;
}

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));
export const DATACENTER_CIDRS_FILE = join(FIXTURES_DIR, "datacenter-cidrs.txt");
export const RESIDENTIAL_CIDRS_FILE = join(FIXTURES_DIR, "residential-cidrs.txt");

export function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${ip}`);
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`not an IPv4 address: ${ip}`);
    const octet = Number(part);
    if (octet > 255) throw new Error(`not an IPv4 address: ${ip}`);
    n = n * 256 + octet;
  }
  return n;
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

export function parseCidr(text: string): Cidr {
  const [ip, bits = "32"] = text.trim().split("/");
  const prefix = Number(bits);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`invalid CIDR: ${text}`);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ipToInt(ip) / size) * size;
  return { text: `${intToIp(base)}/${prefix}`, base, prefix };
}

/** Parse a CIDR list file body: one range per line, `#` comments and blank lines ignored. */
export function parseCidrList(body: string): Cidr[] {
  return body
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map(parseCidr);
}

export function loadCidrList(path: string): Cidr[] {
  return parseCidrList(readFileSync(path, "utf8"));
}

export function cidrContains(cidr: Cidr, ip: string): boolean {
  const n = ipToInt(ip);
  return n >= cidr.base && n < cidr.base + 2 ** (32 - cidr.prefix);
}

export function anyContains(cidrs: readonly Cidr[], ip: string): boolean {
  return cidrs.some((c) => cidrContains(c, ip));
}

/** Deterministic PRNG (mulberry32) so address assignment is reproducible from a run seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A usable host address inside `cidr` (never the network or broadcast address when there is room). */
export function randomAddressIn(cidr: Cidr, random: () => number = Math.random): string {
  const size = 2 ** (32 - cidr.prefix);
  if (size <= 2) return intToIp(cidr.base + Math.floor(random() * size));
  return intToIp(cidr.base + 1 + Math.floor(random() * (size - 2)));
}

/** Hands out addresses from a pool; ranges are weighted by size so big blocks get more users. */
export class AddressPool {
  private readonly total: number;
  private readonly issued = new Set<string>();

  constructor(
    readonly cidrs: readonly Cidr[],
    private readonly random: () => number = Math.random,
  ) {
    if (cidrs.length === 0) throw new Error("address pool needs at least one CIDR");
    // Log-weighting keeps a /8 from swamping every /16 in the sample.
    this.total = cidrs.reduce((sum, c) => sum + (33 - c.prefix), 0);
  }

  /** A fresh address not issued before by this pool (falls back to a repeat when exhausted). */
  next(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      let pick = this.random() * this.total;
      let chosen = this.cidrs[0] as Cidr;
      for (const c of this.cidrs) {
        pick -= 33 - c.prefix;
        if (pick <= 0) {
          chosen = c;
          break;
        }
      }
      const ip = randomAddressIn(chosen, this.random);
      if (!this.issued.has(ip)) {
        this.issued.add(ip);
        return ip;
      }
    }
    return randomAddressIn(this.cidrs[0] as Cidr, this.random);
  }
}
