// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NetworkClassifier } from "../network.ts";
import type { Concurrency, SessionFacts, Signal } from "../types.ts";

/** Viewing from a hosting provider is strong evidence of automation, but VPN users exist, so not 1.0. */
export const DATACENTER_SCORE = 0.8;
/** Sessions beyond the per-device / per-account allowance. */
export const CONCURRENCY_SCORE = 0.9;

/**
 * `datacenter_ip`: the session's network was classified as hosting at start
 * (`datacenter` set), or its ASN is on the operator's hosting list.
 */
export function datacenterSignal(
  session: Pick<SessionFacts, "datacenter" | "asn">,
  classifier?: NetworkClassifier,
): Signal | null {
  if (session.datacenter) {
    return {
      code: "datacenter_ip",
      score: DATACENTER_SCORE,
      details: { network: session.datacenter, asn: session.asn },
    };
  }
  if (classifier && session.asn !== null) {
    const c = classifier.classify(null, session.asn);
    if (c.hosting)
      return { code: "datacenter_ip", score: DATACENTER_SCORE, details: { network: c.label, asn: session.asn } };
  }
  return null;
}

/**
 * `device_concurrency` / `account_concurrency`: the oldest `max` concurrent sessions of a
 * device (or account) are fine; every session beyond them fires. A household with a few
 * screens stays within the allowance; a device running dozens of players does not.
 */
export function concurrencySignal(
  code: "device_concurrency" | "account_concurrency",
  c: Concurrency | null,
  max: number,
): Signal | null {
  if (!c || c.concurrent <= max || c.rank <= max) return null;
  return { code, score: CONCURRENCY_SCORE, details: { rank: c.rank, concurrent: c.concurrent, max } };
}
