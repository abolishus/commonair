// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import type { LoyaltyBalanceDto } from "./state.ts";

/** The contract's default name (`packages/contracts` loyalty settings), stored in English. */
const DEFAULT_POINTS_NAME = "points";

/**
 * A channel's points name for display: a streamer's own name as written, the untouched English
 * default in the viewer's language.
 */
export function displayPointsName(name: string | undefined): string {
  return name === undefined || name === DEFAULT_POINTS_NAME ? t("chatPoints.defaultName") : name;
}

/**
 * Whether the chip shows (scope-calls decision 4): points on and earnable (a daily cap above 0),
 * never on your own channel, and not at zero when there is nothing to spend them on.
 */
export function showPointsChip(
  balance: LoyaltyBalanceDto | null,
  o: { own: boolean; spendable: boolean },
): balance is LoyaltyBalanceDto {
  if (!balance?.enabled || o.own) return false;
  if (balance.accrual.dailyCapPerChannel <= 0) return false;
  return balance.points > 0 || o.spendable;
}

export interface PointsChipProps {
  balance: LoyaltyBalanceDto;
  /** The open prediction's title, when one takes points now. */
  prediction?: string | null;
}

/**
 * The viewer's channel points in the chat input row (`chat-points`), opening "How you earn"
 * (`chat-points-popover`, D4.5): only verified live watch time earns, at the instance's rate
 * (`LoyaltyBalance.accrual`), with the balance and the open prediction. Following and chatting
 * earn nothing, so the popover never mentions them. Points are a loyalty count, never money (ADR
 * 0026): no coin, and no redemption yet (decision 4).
 */
export function PointsChip({ balance, prediction = null }: PointsChipProps): React.JSX.Element {
  const { locale } = useLocale();
  const name = displayPointsName(balance.pointsName);
  const points = formatNumber(balance.points, locale);
  const text = t("chatPoints.balance", { points, name });
  const { pointsPerBlock, blockMinutes, dailyCapPerChannel } = balance.accrual;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) trackUi("watch.points", "view");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="chat-points"
            data-points={balance.points}
            data-name={balance.pointsName}
            aria-label={t("d4Chat.points.trigger", { balance: text })}
            className="shrink-0 tabular-nums"
          >
            <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} aria-hidden />
            <span>{text}</span>
          </Button>
        }
      />
      <PopoverContent data-testid="chat-points-popover" align="start" side="top">
        <PopoverHeader>
          <PopoverTitle>{t("d4Chat.points.title", { name })}</PopoverTitle>
          <PopoverDescription data-testid="chat-points-rate">
            {t("d4Chat.points.rate", {
              points: formatNumber(pointsPerBlock, locale),
              name,
              minutes: blockMinutes,
              cap: formatNumber(dailyCapPerChannel, locale),
            })}
          </PopoverDescription>
        </PopoverHeader>
        <p className="text-xs text-muted-foreground">{t("d4Chat.points.only", { name })}</p>
        <p data-testid="chat-points-balance" className="text-sm font-semibold tabular-nums">
          {t("d4Chat.points.balance", { balance: text })}
        </p>
        {prediction ? (
          <p data-testid="chat-points-prediction" className="break-words text-xs">
            {t("d4Chat.points.prediction", { title: prediction })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
