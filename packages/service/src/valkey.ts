// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { loadEnv, valkeyEnv } from "@commonair/config";
import { Valkey } from "iovalkey";

export type ValkeyClient = Valkey;

/** `VALKEY_CA_FILE`, read through the config schema. */
export function valkeyCaFileFromEnv(source?: Record<string, string | undefined>): string | undefined {
  return loadEnv(valkeyEnv.pick({ VALKEY_CA_FILE: true }), source).VALKEY_CA_FILE;
}

/**
 * Client TLS for a Valkey whose certificate a private CA signed (ADR 0032 §3, S1-d). With a CA
 * the URL must be `rediss://` (or `valkeys://`), and the server is verified against that CA,
 * hostname included. Without one nothing is added: `rediss://` then verifies against the system
 * store, as iovalkey does by itself. `caFile` omitted reads `VALKEY_CA_FILE`; `null` ignores it.
 * Spread the result into the options of every `new Valkey(url, …)` (BullMQ connections too).
 * Errors never quote the URL, which holds a password.
 */
export function valkeyTls(url: string, caFile?: string | null): { tls?: { ca: string; rejectUnauthorized: true } } {
  const ca = caFile === null ? undefined : (caFile ?? valkeyCaFileFromEnv());
  if (!ca) return {};
  if (!/^(?:rediss|valkeys):\/\//i.test(url)) {
    throw new Error("a Valkey CA file is set, so the Valkey URL must use rediss://");
  }
  return { tls: { ca: readFileSync(ca, "utf8"), rejectUnauthorized: true } };
}

/**
 * A Valkey connection. Pub/sub needs a dedicated connection: call
 * `createValkey()` separately for subscribers. `keyPrefix` isolates tests.
 * `caFile` as for {@link valkeyTls}.
 */
export function createValkey(
  url: string,
  opts: { keyPrefix?: string; name?: string; caFile?: string | null } = {},
): Valkey {
  return new Valkey(url, {
    ...valkeyTls(url, opts.caFile),
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
