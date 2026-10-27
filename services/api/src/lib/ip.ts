// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Client address resolution: X-Forwarded-For is honored only from configured trusted proxies. */
import { inCidr } from "@commonair/service";

// One implementation with the tracker (@commonair/service), so both spell addresses alike.
export { clientIp, inCidr, parseIp } from "@commonair/service";

/**
 * A request that came through a proxy we do not trust: it carries X-Forwarded-For but its peer is
 * a private or loopback address that is not in the trusted list. Every client behind such a proxy
 * resolves to the proxy's address and shares one rate-limit subject.
 */
export function looksProxied(socketIp: string, forwardedFor: string | null, trusted: readonly string[]): boolean {
  if (!forwardedFor?.trim()) return false;
  if (trusted.some((c) => inCidr(socketIp, c))) return false;
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "::1/128", "fc00::/7"].some(
    (c) => inCidr(socketIp, c),
  );
}
