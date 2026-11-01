// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EXCLUSION_CATEGORIES } from "@commonair/contracts/enums";
import type * as React from "react";

export interface GroupAppealActionProps {
  broadcastId: string;
  category: (typeof EXCLUSION_CATEGORIES)[number];
  /** Sessions in the excluded group (shown groups have at least 5). */
  sessions: number;
}

/**
 * "Appeal this group" on an excluded group of the analytics page (`appeals.create` with subject
 * `exclusion_group`, decision (m)). Stub from the W2 contract step: W2-rollup-analytics mounts it
 * and W2b-group-appeals fills it (`apps/web/src/components/analytics/group-appeal*`).
 */
export function GroupAppealAction(_props: GroupAppealActionProps): React.JSX.Element | null {
  return null;
}
