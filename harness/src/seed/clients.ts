// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How the seed's API clients reach the stack: through the harness forwarding proxy, each with its
 * own simulated address, as the scenarios' clients do. The auth rate limit is per address, so
 * without this seed-social's bulk sign-ins all share one address and hit HTTP 429 after ten.
 */
import { createApi } from "../api/client.ts";
import { AddressPool, parseCidr, seededRandom } from "../cidrs.ts";
import type { HarnessEnv } from "../env.ts";
import { type ForwardingProxy, startForwardingProxy } from "../proxy.ts";
import type { UserFactoryOptions } from "../users.ts";
import type { SeedUnitName } from "./types.ts";

/**
 * Simulated client addresses: the shared (CGNAT) space only, never a routable public address, so
 * the session rows the API writes carry no real person's address.
 */
export const SEED_CLIENT_CIDR = "100.64.0.0/10";

let proxy: ForwardingProxy | null = null;

/** A stable per-unit seed, so two units rarely draw the same addresses. Pure. */
export function unitAddressSeed(unit: SeedUnitName): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < unit.length; i++) h = Math.imul(h ^ unit.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A `UserFactory` `apiFactory` that gives every client the proxy and a fresh simulated address. */
export function seedApiFactory(env: HarnessEnv, unit: SeedUnitName): NonNullable<UserFactoryOptions["apiFactory"]> {
  const addresses = new AddressPool([parseCidr(SEED_CLIENT_CIDR)], seededRandom(unitAddressSeed(unit)));
  return (o) => {
    proxy ??= startForwardingProxy({ target: env.HARNESS_API_URL });
    return createApi({ ...o, baseUrl: proxy.url, clientIp: o.clientIp ?? addresses.next() });
  };
}

/** Stops the shared proxy (run.ts, once every unit is done). */
export async function stopSeedProxy(): Promise<void> {
  await proxy?.stop();
  proxy = null;
}
