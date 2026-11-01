// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

export interface AttestationsPanelProps {
  /** The owner's channel slug. */
  channel: string;
  /** One broadcast's entries; absent for the channel's whole chain. */
  broadcastId?: string;
}

/**
 * The owner's signed audience attestations with share links (`integrity.attestations.*`, ADR
 * 0014), for the analytics page to mount. Stub from the W2 contract step: W2b-attestations fills
 * it (`apps/web/src/components/attestations/**`).
 */
export function AttestationsPanel(_props: AttestationsPanelProps): React.JSX.Element | null {
  return null;
}
