// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `coop.shares.askRefundDetails` (overhaul wave 5, ADR 0042): a treasurer has the platform email a
 * leaving member for share refund details (`coop/refund-details.ts`). The response is the share,
 * never the member's address.
 */
import { askRefundDetails } from "../coop/refund-details.ts";
import { shareView } from "../coop/membership.ts";
import { userPicks } from "../coop/shared.ts";
import { os, requireCaller } from "../lib/orpc.ts";

export const shareRefundDetails = {
  askRefundDetails: os.coop.shares.askRefundDetails.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const { share, deletionScheduledFor } = await askRefundDetails(deps, caller.user.id, input.shareId);
    const leaving = new Map(deletionScheduledFor ? [[share.userId, deletionScheduledFor]] : []);
    return shareView(share, await userPicks(deps.db, [share.userId]), leaving);
  }),
};
