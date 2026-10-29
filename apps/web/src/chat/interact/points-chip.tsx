// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { LoyaltyBalanceDto } from "./state.ts";

/**
 * The viewer's channel points in the chat header (`chat-points`): signed-in viewers only, and
 * only while the channel's points are on. Points are a loyalty count, never money (ADR 0026).
 */
export function PointsChip({ balance }: { balance: LoyaltyBalanceDto }): React.JSX.Element {
  const { locale } = useLocale();
  const text = t("chatPoints.balance", { points: formatNumber(balance.points, locale), name: balance.pointsName });
  return (
    <StatusBadge
      tone="neutral"
      data-testid="chat-points"
      data-points={balance.points}
      data-name={balance.pointsName}
      aria-label={t("chatPoints.label", { balance: text })}
    >
      <HugeiconsIcon icon={Coins01Icon} strokeWidth={2} aria-hidden className="size-3" />
      <span className="tabular-nums">{text}</span>
    </StatusBadge>
  );
}
