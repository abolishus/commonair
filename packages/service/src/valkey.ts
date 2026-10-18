// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Valkey } from "iovalkey";

export type ValkeyClient = Valkey;

/**
 * A Valkey connection. Pub/sub needs a dedicated connection: call
 * `createValkey()` separately for subscribers. `keyPrefix` isolates tests.
 */
export function createValkey(url: string, opts: { keyPrefix?: string; name?: string } = {}): Valkey {
  return new Valkey(url, {
    keyPrefix: opts.keyPrefix,
    connectionName: opts.name,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
}

/** Readiness check for runService. */
export const valkeyCheck = (client: Valkey) => async () => {
  const pong = await client.ping();
  if (pong !== "PONG") throw new Error(`unexpected ping reply: ${String(pong)}`);
};
