// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gateway-specific tuning.
 *
 * CONTRACT-REQUEST: move these into `servicePorts` (or a new `ircEnv`) in
 * packages/config/src/env.ts and document them in `.env.example`:
 *   IRC_MAX_CONNECTIONS (20000), IRC_MAX_CONNECTIONS_PER_IP (50),
 *   IRC_CONNECT_BURST_PER_IP (20), IRC_CONNECT_PER_SECOND_PER_IP (2).
 * Until then they are read here, with the same defaults.
 */
import { z } from "zod";
import { DEFAULT_CONNECTION_LIMITS, type ConnectionLimits } from "./admission.ts";
import { parseCidr, type Cidr } from "./net.ts";

const positiveInt = z.coerce.number().int().positive();
const positive = z.coerce.number().positive();

export const ircEnv = z.object({
  IRC_MAX_CONNECTIONS: positiveInt.default(DEFAULT_CONNECTION_LIMITS.maxConnections),
  IRC_MAX_CONNECTIONS_PER_IP: positiveInt.default(DEFAULT_CONNECTION_LIMITS.maxPerIp),
  IRC_CONNECT_BURST_PER_IP: positiveInt.default(DEFAULT_CONNECTION_LIMITS.connectBurstPerIp),
  IRC_CONNECT_PER_SECOND_PER_IP: positive.default(DEFAULT_CONNECTION_LIMITS.connectPerSecondPerIp),
});

export function connectionLimits(env: z.output<typeof ircEnv>): ConnectionLimits {
  return {
    maxConnections: env.IRC_MAX_CONNECTIONS,
    maxPerIp: env.IRC_MAX_CONNECTIONS_PER_IP,
    connectBurstPerIp: env.IRC_CONNECT_BURST_PER_IP,
    connectPerSecondPerIp: env.IRC_CONNECT_PER_SECOND_PER_IP,
  };
}

/** Parse TRUSTED_PROXY_CIDRS entries; a bad entry is a startup error, not silently ignored. */
export function trustedProxies(entries: readonly string[]): Cidr[] {
  return entries.map((e) => {
    const c = parseCidr(e);
    if (!c) throw new Error(`TRUSTED_PROXY_CIDRS: invalid CIDR ${JSON.stringify(e)}`);
    return c;
  });
}
