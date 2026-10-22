// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { api } from "../../lib/api.ts";
import type { MembershipViewDto } from "../../lib/coop.ts";
import { useLoad, type Loaded } from "../money/use-load.ts";

/** The viewer's memberships, or null data while signed out (no call is made then). */
export function useMyMembership(me: SessionUser | null): Loaded<MembershipViewDto | null> {
  return useLoad(me ? `membership|${me.id}` : "membership|-", () =>
    me ? api().coop.membership() : Promise.resolve(null),
  );
}

/** The generic toast for a refused co-op action ("sign in again" when the session is gone). */
export function toastCoopError(err: unknown): void {
  toastActionError(err, t("coop.actionFailed"));
}
