// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbound URL checks for addresses our servers connect to on a member's behalf (relay health
 * checks, simulcast pushes): refuse anything that resolves to a non-public address (SSRF).
 * Connections the API makes itself go to the address that was checked (`pinnedGet`), so a DNS
 * answer that changes after the check (rebinding) cannot redirect them. Simulcast pushes are made
 * by the media service, which re-checks the target when it connects.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { parseIp } from "./ip.ts";
import { isPublicAddress } from "./netrange.ts";

/** Resolve a hostname to every address it currently has. */
export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface OutboundPolicy {
  protocols: readonly string[];
  /** OUTBOUND_ALLOW_PRIVATE_NETWORKS: skip the public-address requirement (local stack only). */
  allowPrivate: boolean;
  resolve: ResolveHost;
}

export type OutboundTarget = { ok: true; url: URL; host: string; addresses: string[] } | { ok: false; reason: string };

/** A host spelled only as numbers (`0177.0.0.1`, `0x7f.1`, `2130706433`): resolvers read these as IPv4. */
const NUMERIC_LABELS = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*$/i;
const CANONICAL_V4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

/**
 * Check `raw` and resolve it. On success, `addresses` are the vetted addresses to connect to
 * (empty when private networks are allowed: the caller then resolves normally).
 */
export async function resolveOutbound(raw: string, policy: OutboundPolicy): Promise<OutboundTarget> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!policy.protocols.includes(u.protocol)) return { ok: false, reason: "protocol" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return { ok: false, reason: "no host" };
  if (policy.allowPrivate) return { ok: true, url: u, host, addresses: [] };
  // Octal, hex and short forms mean different addresses to different parsers: only plain
  // dotted-decimal counts as an IPv4 literal.
  if (NUMERIC_LABELS.test(host) && !CANONICAL_V4.test(host)) return { ok: false, reason: "non-canonical numeric host" };
  if (parseIp(host))
    return isPublicAddress(host)
      ? { ok: true, url: u, host, addresses: [host] }
      : { ok: false, reason: "non-public address" };
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal") || !lower.includes("."))
    return { ok: false, reason: "non-public host" };
  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  // Every address must be public: a mixed answer could route the connection internally.
  if (!addresses.every(isPublicAddress)) return { ok: false, reason: "resolves to a non-public address" };
  return { ok: true, url: u, host, addresses };
}

/**
 * Why `raw` may not be used as an outbound target, or null. Reasons are for logs; clients get a
 * generic error so the check cannot be used to map our network.
 */
export async function outboundUrlProblem(raw: string, policy: OutboundPolicy): Promise<string | null> {
  const t = await resolveOutbound(raw, policy);
  return t.ok ? null : t.reason;
}

/**
 * GET `url`, connecting to `address` instead of resolving the host again. The Host header and
 * TLS server name stay the URL's host, so virtual hosting and certificate checks work. With a
 * null address the host is resolved normally (private networks allowed). Resolves to the status.
 *
 * `timeoutMs` bounds the whole exchange up to the response headers (connect, TLS, request,
 * headers), not just socket idleness: a server that trickles bytes cannot hold the request open.
 */
export type PinnedGet = (url: URL, address: string | null, timeoutMs: number) => Promise<number>;

export const pinnedGet: PinnedGet = (url, address, timeoutMs) =>
  new Promise((resolve, reject) => {
    const pinTo = (ip: string): LookupFunction => {
      const family = parseIp(ip)?.v === 6 ? 6 : 4;
      return (_host, opts, cb) => {
        if (opts.all)
          (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      };
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", timeout: timeoutMs, ...(address ? { lookup: pinTo(address) } : {}) },
      (res) => {
        clearTimeout(deadline);
        // Only the status matters: drop the body rather than let a trickling one hold the socket.
        res.on("error", () => {});
        res.destroy();
        resolve(res.statusCode ?? 0);
      },
    );
    // The socket `timeout` above fires only after `timeoutMs` of silence; this one is absolute.
    const deadline = setTimeout(() => req.destroy(new Error("deadline exceeded")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end();
  });
