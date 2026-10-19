// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Gateway-specific tuning; the variables live in `@commonair/config` (`ircEnv`). */
import { ircEnv } from "@commonair/config";
import type { z } from "zod";
import type { ConnectionLimits } from "./admission.ts";
import { parseCidr, type Cidr } from "./net.ts";

export { ircEnv };

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
