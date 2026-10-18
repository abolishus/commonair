// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbound URL checks for addresses our servers connect to on a member's behalf (relay health
 * checks, simulcast pushes): refuse anything that resolves to a non-public address (SSRF).
 */
import { lookup } from "node:dns/promises";
import { parseIp } from "./ip.ts";
import { isPublicAddress } from "./netrange.ts";

/** Resolve a hostname to every address it currently has. */
export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface OutboundPolicy {
  protocols: readonly string[];
  /** Development only: skip the public-address requirement (local relays, test fixtures). */
  allowPrivate: boolean;
  resolve: ResolveHost;
}

/**
 * Why `raw` may not be used as an outbound target, or null. Reasons are for logs; clients get a
 * generic error so the check cannot be used to map our network.
 */
export async function outboundUrlProblem(raw: string, policy: OutboundPolicy): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "unparseable";
  }
  if (!policy.protocols.includes(u.protocol)) return "protocol";
  if (u.username || u.password) return "credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "no host";
  if (policy.allowPrivate) return null;
  if (parseIp(host)) return isPublicAddress(host) ? null : "non-public address";
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal") || !lower.includes("."))
    return "non-public host";
  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch {
    return "unresolvable";
  }
  if (addresses.length === 0) return "unresolvable";
  // Every address must be public: a mixed answer could route the connection internally.
  return addresses.every(isPublicAddress) ? null : "resolves to a non-public address";
}
