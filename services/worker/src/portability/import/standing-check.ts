// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checking a bundle's standing statement at import (ADR 0037 decisions 4 and 5):
 *
 * 1. No statement: `missing` (a Twitch bundle never has one; a CommonAir one is then "not verified").
 * 2. The claimed issuer's keys: this instance's own rows when the issuer is this instance, else
 *    fetched from `<issuer>/.well-known/commonair-portability` through the SSRF guard.
 * 3. `verifyStanding` (signature, canonical bytes, kid, validity window).
 * 4. `checkStandingBinding`: the statement must be about this very bundle (digest) and come from
 *    the bundle's exporting instance (issuer host = `instance.domain`).
 *
 * Any failure in 2–4 is `unverified` with a code, never "clean": the import goes ahead, marked
 * "standing not verified". Only a `verified` statement can refuse an import (`refusesImport`).
 */
import type { PortabilityBundle } from "@commonair/contracts/portability";
import type { Executor } from "@commonair/db";
import { type StandingKey, StandingStatement, checkStandingBinding, verifyStanding } from "@commonair/tokens/standing";
import { fetchIssuerKeys, type FetchKeysOptions, localStandingKeys } from "./issuer-keys.ts";

export type StandingCheck =
  | { state: "missing" }
  | { state: "verified"; issuer: string; statement: StandingStatement }
  | { state: "unverified"; issuer: string | null; reason: string };

export interface StandingCheckDeps {
  db: Executor;
  /** This instance's origin: its own statements are checked against the local key rows. */
  ownOrigin: string;
  fetch: FetchKeysOptions;
  /** Tests replace the network fetch. */
  fetchKeys?: (issuer: string) => Promise<{ ok: true; keys: StandingKey[] } | { ok: false; error: string }>;
  now: Date;
}

/** The issuer a payload claims, read before anything is trusted (only to know where to look). */
export function claimedIssuer(payload: string): string | null {
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { issuer?: unknown };
    const parsed = StandingStatement.shape.issuer.safeParse(json?.issuer);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function checkStanding(bundle: PortabilityBundle, deps: StandingCheckDeps): Promise<StandingCheck> {
  const signed = bundle.standing;
  if (!signed) return { state: "missing" };
  const issuer = claimedIssuer(signed.payload);
  if (!issuer) return { state: "unverified", issuer: null, reason: "malformed" };
  let keys: StandingKey[];
  if (issuer === deps.ownOrigin) keys = await localStandingKeys(deps.db);
  else {
    const fetched = await (deps.fetchKeys ?? ((i: string) => fetchIssuerKeys(i, deps.fetch)))(issuer);
    if (!fetched.ok) return { state: "unverified", issuer, reason: `keys_${fetched.error}` };
    keys = fetched.keys;
  }
  const verified = await verifyStanding(signed, keys, deps.now);
  if (!verified.ok) return { state: "unverified", issuer, reason: verified.error };
  const binding = await checkStandingBinding(verified.statement, bundle);
  if (binding) return { state: "unverified", issuer, reason: binding };
  return { state: "verified", issuer, statement: verified.statement };
}

/** Decision (o): a verified statement that says the channel is suspended or under a legal hold. */
export function refusesImport(check: StandingCheck): "standing_suspended" | "standing_legal_hold" | null {
  if (check.state !== "verified") return null;
  if (check.statement.activeSuspension) return "standing_suspended";
  if (check.statement.legalHold) return "standing_legal_hold";
  return null;
}

/** `portability_imports.standing_verified`: null for a Twitch bundle, else whether it verified. */
export function standingVerifiedColumn(source: PortabilityBundle["source"], check: StandingCheck): boolean | null {
  if (source === "twitch") return null;
  return check.state === "verified";
}
