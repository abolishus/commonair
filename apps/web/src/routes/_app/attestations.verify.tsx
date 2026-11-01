// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { AttestationVerifier } from "../../components/attestations/verifier.tsx";

/**
 * `/attestations/verify`: the public verifier for signed audience attestations (ADR 0014; the
 * API's `integrity.attestations.verify` and `/.well-known/commonair-attestation`). Public, no
 * session. The page is `AttestationVerifier`, which W2b-attestations owns.
 */
export const Route = createFileRoute("/_app/attestations/verify")({
  component: AttestationVerifier,
});
