// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type NetworkClassifier, PRIVACY_RELAY_LABEL_PREFIX } from "../network.ts";
import type { Concurrency, SessionFacts, Signal } from "../types.ts";

/**
 * Viewing from a hosting provider is evidence of automation, but VPN and corporate-proxy
 * users exist, so it is below the exclusion score: it needs corroboration to exclude.
 */
export const DATACENTER_SCORE = 0.6;
/** Consumer privacy relays carry real people; weak corroboration only, never fatal alone. */
export const PRIVACY_RELAY_SCORE = 0.3;
/** Sessions beyond the per-device / per-account allowance. */
export const CONCURRENCY_SCORE = 0.9;

function networkSignal(label: string | null, asn: number | null): Signal {
  if (label?.startsWith(PRIVACY_RELAY_LABEL_PREFIX)) {
    return {
      code: "privacy_relay",
      score: PRIVACY_RELAY_SCORE,
      details: { network: label.slice(PRIVACY_RELAY_LABEL_PREFIX.length) || null, asn },
    };
  }
  return { code: "datacenter_ip", score: DATACENTER_SCORE, details: { network: label, asn } };
}

/**
 * `datacenter_ip` / `privacy_relay`: the session's network was on the operator list at
 * start (`datacenter` set), or its ASN is on the list now.
 */
export function datacenterSignal(
  session: Pick<SessionFacts, "datacenter" | "asn">,
  classifier?: NetworkClassifier,
): Signal | null {
  if (session.datacenter) return networkSignal(session.datacenter, session.asn);
  if (classifier && session.asn !== null) {
    const c = classifier.classify(null, session.asn);
    if (c.hosting) return networkSignal(c.label, session.asn);
  }
  return null;
}

/**
 * `device_concurrency` / `account_concurrency`: the newest `max` concurrent sessions of a
 * device (or account) are fine; every older session beyond them fires. Ranking newest
 * first means a reload (whose stale predecessor is superseded and ended by the job, see
 * `scoreActiveSessions`) is never the one that fires. A household with a few screens stays
 * within the allowance; a device running dozens of players does not.
 */
export function concurrencySignal(
  code: "device_concurrency" | "account_concurrency",
  c: Concurrency | null,
  max: number,
): Signal | null {
  if (!c || c.concurrent <= max || c.rank <= max) return null;
  return { code, score: CONCURRENCY_SCORE, details: { rank: c.rank, concurrent: c.concurrent, max } };
}
