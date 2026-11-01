// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

export interface FederationSettingsProps {
  /** The streamer's channel slug (`federation.settings.get` / `update`). */
  channel: string;
}

/**
 * The channel's ActivityPub federation section on the stream manager (`/dashboard`; ADR 0030):
 * the on/off switch, the `@slug@domain` handle and the remote followers. Hidden while
 * `instance.info().features.federation` is false. Stub from the batch 7 contract step: N4-web
 * fills it (`apps/web/src/components/federation/**`).
 */
export function FederationSettings(_props: FederationSettingsProps): React.JSX.Element | null {
  return null;
}
