// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isValidCidr } from "./ip.ts";

/** Validate TRUSTED_PROXY_CIDRS entries; a bad entry is a startup error, not silently ignored. */
export function trustedProxies(entries: readonly string[]): string[] {
  return entries.map((e) => {
    if (!isValidCidr(e)) throw new Error(`TRUSTED_PROXY_CIDRS: invalid CIDR ${JSON.stringify(e)}`);
    return e;
  });
}
