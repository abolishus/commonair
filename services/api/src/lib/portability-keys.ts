// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/.well-known/commonair-portability` (decision (n)): the instance origin and every key it has
 * signed standing statements with, in the `/.well-known/commonair-attestation` shape, so another
 * instance verifies an imported bundle's statement offline. Public keys only: the API never holds
 * `PORTABILITY_SIGNING_KEY` (the worker writes the rows when it first signs with a key).
 */
import type { AttestationKeyHistory } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import { asc } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { instanceOrigin } from "../routes/attestation-verify.ts";

const { portabilitySigningKeys: keys } = schema;

/** Every standing-statement signing key, oldest first. */
export async function loadPortabilityKeys(db: Executor): Promise<AttestationKeyHistory["keys"]> {
  const rows = await db.select().from(keys).orderBy(asc(keys.firstUsedAt), asc(keys.kid));
  return rows.map((k) => ({
    kid: k.kid,
    algorithm: "Ed25519" as const,
    publicKey: k.publicKey,
    firstUsedAt: k.firstUsedAt.toISOString(),
    retiredAt: k.retiredAt?.toISOString() ?? null,
    compromisedAt: k.compromisedAt?.toISOString() ?? null,
  }));
}

export async function portabilityKeyHistory(deps: Pick<Deps, "db" | "site">): Promise<AttestationKeyHistory> {
  return { origin: instanceOrigin(deps), keys: await loadPortabilityKeys(deps.db) };
}
