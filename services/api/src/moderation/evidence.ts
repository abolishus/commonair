// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The evidence opening key (ADR 0006 Q4). Only the `legal` handlers in routes/moderation.ts
 * import this module: nothing else in the API can decrypt sealed evidence or NCMEC snapshots.
 * Decrypted bytes are returned to the caller and never logged, cached or written anywhere.
 */
import { importOpeningKey, openJson, type OpeningKey } from "@commonair/moderation";
import type { Deps } from "../deps.ts";

const keys = new WeakMap<Deps, Promise<OpeningKey>>();

function openingKey(deps: Deps): Promise<OpeningKey> {
  let k = keys.get(deps);
  if (!k) {
    k = importOpeningKey(deps.env.EVIDENCE_PRIVATE_KEY);
    keys.set(deps, k);
    k.catch(() => keys.delete(deps));
  }
  return k;
}

/** Fail-closed check at startup: the private key parses and matches the public key's id. */
export async function checkOpeningKey(deps: Deps, sealingKeyId: string): Promise<void> {
  const k = await openingKey(deps);
  if (k.keyId !== sealingKeyId) throw new Error("EVIDENCE_PRIVATE_KEY does not belong to EVIDENCE_PUBLIC_KEY");
}

export async function openEvidence(deps: Deps, sealed: Uint8Array): Promise<Uint8Array> {
  return (await openingKey(deps)).open(sealed);
}

export async function openSnapshot(deps: Deps, sealed: Uint8Array): Promise<unknown> {
  return openJson(await openingKey(deps), sealed);
}
