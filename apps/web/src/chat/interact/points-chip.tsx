// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Progress } from "@commonair/ui/components/progress";
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

/**
 * Today's progress toward the daily cap (overhaul wave 5), or null when there is none to show:
 * the balance is not the caller's own (`earnedToday` null) or accrual is off (a cap of 0).
 */
export function pointsToday(
  earnedToday: number | null,
  cap: number,
): { earned: number; cap: number; left: number; percent: number } | null {
  if (earnedToday === null || cap <= 0) return null;
  // The worker stops at the cap; a cap lowered mid-day can leave today above it.
  const earned = Math.min(Math.max(earnedToday, 0), cap);
  return { earned, cap, left: cap - earned, percent: Math.round((earned / cap) * 100) };
}

function PointsToday({
  earnedToday,
  cap,
  locale,
}: {
  earnedToday: number | null;
  cap: number;
  locale: string;
}): React.JSX.Element | null {
  const today = pointsToday(earnedToday, cap);
  if (!today) return null;
  return (
    <div
      data-testid="chat-points-today"
      data-earned={today.earned}
      data-cap={today.cap}
      className="flex flex-col gap-1"
    >
      {/* The line below says it in words; the bar is only its picture. */}
      <Progress value={today.percent} aria-hidden />
      <p className="text-xs text-muted-foreground tabular-nums">
        {t("w5Watch.points.today", {
          earned: formatNumber(today.earned, locale),
          cap: formatNumber(today.cap, locale),
        })}{" "}
        {t("w5Watch.points.todayLeft", { count: today.left })}
      </p>
    </div>
  );
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
        <PointsToday earnedToday={balance.earnedToday} cap={dailyCapPerChannel} locale={locale} />
        {prediction ? (
          <p data-testid="chat-points-prediction" className="break-words text-xs">
            {t("d4Chat.points.prediction", { title: prediction })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
