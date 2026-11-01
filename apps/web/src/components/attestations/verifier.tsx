// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { NotFoundState } from "../money/not-found.tsx";

/**
 * The public attestation verifier (`/attestations/verify`, ADR 0014: `integrity.attestations.verify`,
 * `integrity.attestations.bundle` and `/.well-known/commonair-attestation`). Stub from the W2
 * contract step, mounted by the route: W2b-attestations fills it (`components/attestations/**`).
 */
export function AttestationVerifier(): React.JSX.Element {
  return <NotFoundState />;
}
