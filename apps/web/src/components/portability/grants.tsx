// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

/**
 * The viewer's portability grants on `/settings/privacy` (ADR 0037): per followed channel, whether
 * the viewer may be emailed once if that channel moves (`portability.grants.*`). Stub from the
 * batch 7 contract step: W3-portability fills it (`apps/web/src/components/portability/**`).
 */
export function PortabilityGrants(): React.JSX.Element | null {
  return null;
}
