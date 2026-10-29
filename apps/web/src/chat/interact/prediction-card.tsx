// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, formatNumber, useLocale } from "@commonair/ui";
import { ViewerPredictionCard } from "@commonair/ui/blocks/interact-viewer";
import * as React from "react";
import { type MessageKey, t } from "../../i18n/index.ts";
import { type InteractClient, interactErrorKey, isStaffRefusal } from "./client.ts";
import { MAX_BET_POINTS, betAmount, type LoyaltyBalanceDto, type PredictionViewDto } from "./state.ts";

export interface ChatPredictionCardProps {
  prediction: PredictionViewDto;
  signedIn: boolean;
  /** The owner, editors and moderators cannot bet (ADR 0026): no betting controls for them. */
  staff: boolean;
  points: LoyaltyBalanceDto | null;
  client: InteractClient;
  onBet: (prediction: PredictionViewDto) => void;
  onPointsSpent: () => void;
}

/**
 * The prediction pinned above the chat log (`chat-prediction`): outcomes with their points and
 * bettors, an amount bounded by the viewer's points and 250,000, one bet button per outcome, then
 * the viewer's bet and, once resolved, the payout or the refund.
 */
export function ChatPredictionCard({
  prediction: p,
  signedIn,
  staff,
  points,
  client,
  onBet,
  onPointsSpent,
}: ChatPredictionCardProps): React.JSX.Element {
  const { locale } = useLocale();
  const [amount, setAmount] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<MessageKey | null>(null);
  // The API is the authority on who counts as staff (editors are not in the chat frame).
  const [refusedStaff, setRefusedStaff] = React.useState(false);

  const balance = points?.points ?? 0;
  const name = points?.pointsName ?? t("chatPoints.defaultName");
  const fmt = (n: number) => formatNumber(n, locale);
  const value = betAmount(amount, balance);
  const isStaff = staff || refusedStaff;

  const bet = async (outcomeId: string) => {
    if (value === null) return;
    setPending(true);
    setError(null);
    try {
      const view = await client.bet({ id: p.id, outcomeId, points: value });
      onBet(view);
      setAmount("");
      onPointsSpent();
    } catch (err) {
      // A ban or timeout is FORBIDDEN too, and ends; only a staff refusal hides betting for good.
      if (isStaffRefusal(err)) setRefusedStaff(true);
      setError(interactErrorKey(err, "prediction"));
    } finally {
      setPending(false);
    }
  };

  const titleOf = (id: string | null) => p.outcomes.find((o) => o.id === id)?.title ?? "";
  const meta =
    p.status === "active" ? (
      <>
        {t("chatPrediction.locksIn")} <RelativeTime date={p.locksAt} tooltip={false} />
      </>
    ) : p.status === "locked" ? (
      t("chatPrediction.locked")
    ) : p.status === "resolved" ? (
      t("chatPrediction.winner", { outcome: titleOf(p.winningOutcomeId) })
    ) : (
      t("chatPrediction.canceled")
    );

  const myBetLabel = (bet: NonNullable<PredictionViewDto["myBet"]>): string => {
    const vars = { points: fmt(bet.points), name, outcome: titleOf(bet.outcomeId) };
    if (p.status === "canceled") return t("chatPrediction.refunded", vars);
    if (p.status === "resolved" && bet.payout !== null)
      return bet.payout > 0
        ? t("chatPrediction.won", { ...vars, payout: fmt(bet.payout) })
        : t("chatPrediction.lost", vars);
    return t("chatPrediction.myBet", vars);
  };

  const max = Math.min(MAX_BET_POINTS, balance);
  return (
    <ViewerPredictionCard
      predictionId={p.id}
      status={p.status}
      title={p.title}
      heading={
        p.status === "resolved" || p.status === "canceled" ? t("chatPrediction.result") : t("chatPrediction.title")
      }
      meta={meta}
      outcomes={p.outcomes.map((o) => ({
        ...o,
        summary: t("chatPrediction.outcomeSummary", { points: fmt(o.points), name, count: o.users }),
        betLabel: t("chatPrediction.bet", { outcome: o.title }),
        winner: p.status === "resolved" && o.id === p.winningOutcomeId,
      }))}
      canBet={signedIn && !isStaff && points !== null && max >= 1}
      amount={{
        value: amount,
        onValueChange: setAmount,
        min: 1,
        max: Math.max(1, max),
        label: t("chatPrediction.amount", { name }),
        invalid: amount.trim() !== "" && value === null,
      }}
      onBet={(id) => void bet(id)}
      betDisabled={pending || value === null}
      myBet={p.myBet ? { ...p.myBet, label: myBetLabel(p.myBet) } : null}
      error={error ? t(error) : undefined}
      hint={
        !signedIn
          ? t("chatPrediction.signIn")
          : !isStaff && points !== null && max < 1 && p.status === "active" && !p.myBet
            ? t("chatPrediction.noPoints", { name })
            : undefined
      }
      liveSummary={p.outcomes
        .map((o) => t("chatPrediction.outcomeLive", { title: o.title, points: fmt(o.points), name }))
        .join(" ")}
      toggleLabel={t("chatPrediction.toggle")}
    />
  );
}
