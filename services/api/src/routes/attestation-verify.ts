// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public side of signed audience attestations (W2b-attestations, ADR 0014): the verifier
 * (`integrity.attestations.verify`) and the key history at `/.well-known/commonair-attestation`
 * (`integrity.keys.list`, served by the OpenAPI handler as `/api/.well-known/commonair-attestation`;
 * Caddy rewrites the bare path to it). The API verifies with `@commonair/tokens/attestation` and
 * never signs: `INTEGRITY_SIGNING_KEY` is the worker's alone (batch 6 decision (l)).
 * Contract-step stubs (HTTP 501) until that unit implements them; `./integrity.ts` mounts them.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const attestationVerify = os.integrity.attestations.verify.handler(notImplemented);

export const attestationKeys = os.integrity.keys.list.handler(notImplemented);
