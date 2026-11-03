// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, formatNumber, useLocale } from "@commonair/ui";
import { ViewerPredictionCard } from "@commonair/ui/blocks/interact-viewer";
import * as React from "react";
import { type MessageKey, t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorReason, errorRequirement } from "../../lib/coop.ts";
import { displayPointsName } from "./points-chip.tsx";
import { type InteractClient, interactErrorKey, isStaffRefusal } from "./client.ts";
import { MAX_BET_POINTS, betAmount, type LoyaltyBalanceDto, type PredictionViewDto } from "./state.ts";

/** The channel a prediction runs on, as the channel page knows it (batch 8 contract step §3.8). */
export interface PredictionChannel {
  id: string;
  /** Whether the channel is live now: the grace window after a lock is offered only while it is. */
  live: boolean;
}

export interface ChatPredictionCardProps {
  prediction: PredictionViewDto;
  /**
   * The channel and its live state, or null where the page does not know them. Accepted and not
   * read yet: B8-web uses it for the grace window (W3-fair-predictions request 3).
   */
  channel?: PredictionChannel | null;
  signedIn: boolean;
  /** The owner, editors and moderators cannot bet (ADR 0026): no betting controls for them. */
  staff: boolean;
  points: LoyaltyBalanceDto | null;
  client: InteractClient;
  onBet: (prediction: PredictionViewDto) => void;
  onPointsSpent: () => void;
}

/**
 * Why a bet was refused, as `chat-prediction-refused`'s `data-reason` (docs/testing/b7-selectors.md;
 * batch 7 decision (v)): the channel's team, a DVR / catching-up session, a player too far behind
 * live, no verified-watch standing, or betting closed (past the lock in what the viewer saw). Any
 * other failure (a ban, no points, the network) is `other`.
 */
export type BetRefusalReason = "team" | "not_live" | "behind" | "unverified" | "closed" | "other";

export function betRefusalReason(err: unknown): BetRefusalReason {
  if (isStaffRefusal(err)) return "team";
  const requirement = errorRequirement(err);
  if (requirement === "not_live" || requirement === "behind" || requirement === "unverified") return requirement;
  // A second bet on the same prediction is a CONFLICT too, but nothing to do with the lock.
  if (errorCode(err) === "CONFLICT" && errorReason(err) !== "already_bet") return "closed";
  return "other";
}

const REFUSAL_KEYS: Readonly<Record<Exclude<BetRefusalReason, "other">, MessageKey>> = {
  team: "chatPrediction.error.staff",
  not_live: "fairPrediction.refused.notLive",
  behind: "fairPrediction.refused.behind",
  unverified: "fairPrediction.refused.unverified",
  closed: "fairPrediction.refused.closed",
};

/** The message for a refused bet: the fair-prediction reasons first, then the E8 messages. */
export function betRefusalMessage(err: unknown): MessageKey {
  const reason = betRefusalReason(err);
  if (reason !== "other") return REFUSAL_KEYS[reason];
  if (errorCode(err) === "CONFLICT") return "fairPrediction.refused.alreadyBet";
  return interactErrorKey(err, "prediction");
}

/**
 * The public result card (`chat-prediction-result`, decision (v)): the pool, the winners and
 * what was paid back, which on a resolve adds up to the pool and on a cancel is every stake.
 */
export function PredictionResult({
  prediction: p,
  name,
  fmt,
}: {
  prediction: PredictionViewDto;
  name: string;
  fmt: (n: number) => string;
}): React.JSX.Element | null {
  const r = p.result;
  if (!r) return null;
  const vars = { paid: fmt(r.payoutSum), pool: fmt(r.pool), name };
  const paid =
    r.payoutSum !== r.pool
      ? t("fairPrediction.result.mismatch", vars)
      : p.status === "canceled"
        ? t("fairPrediction.result.refunded", vars)
        : t("fairPrediction.result.paid", vars);
  return (
    <span
      data-testid="chat-prediction-result"
      data-pool={r.pool}
      data-winners={r.winners}
      data-payout-sum={r.payoutSum}
      className="grid gap-0.5"
    >
      <span>{t("fairPrediction.result.summary", { pool: fmt(r.pool), name, winners: r.winners })}</span>
      <span>{paid}</span>
    </span>
  );
}

/**
 * The prediction pinned above the chat log (`chat-prediction`): outcomes with their points and
 * bettors, an amount bounded by the viewer's points and 250,000, one bet button per outcome, then
 * the viewer's bet and, once resolved, the payout or the refund and the result card. Bets lock at
 * what the viewer sees (the client sends the playhead, `withPlayhead`); a refusal says why.
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
  const [refused, setRefused] = React.useState<{ reason: BetRefusalReason; key: MessageKey } | null>(null);
  // The API is the authority on who counts as staff (editors are not in the chat frame).
  const [refusedStaff, setRefusedStaff] = React.useState(false);

  const balance = points?.points ?? 0;
  const name = displayPointsName(points?.pointsName);
  const fmt = (n: number) => formatNumber(n, locale);
  const value = betAmount(amount, balance);
  const isStaff = staff || refusedStaff;

  const bet = async (outcomeId: string) => {
    if (value === null) return;
    setPending(true);
    setRefused(null);
    try {
      const view = await client.bet({ id: p.id, outcomeId, points: value });
      onBet(view);
      setAmount("");
      onPointsSpent();
    } catch (err) {
      // A ban or timeout is FORBIDDEN too, and ends; only a staff refusal hides betting for good.
      if (isStaffRefusal(err)) setRefusedStaff(true);
      setRefused({ reason: betRefusalReason(err), key: betRefusalMessage(err) });
    } finally {
      setPending(false);
    }
  };

  const titleOf = (id: string | null) => p.outcomes.find((o) => o.id === id)?.title ?? "";
  const meta =
    p.status === "active" ? (
      <>
        {t("chatPrediction.locksIn")} <RelativeTime date={p.locksAt} tooltip={false} />{" "}
        <span data-testid="chat-prediction-locks-note">{t("fairPrediction.locksNote")}</span>
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

  const settled = p.status === "resolved" || p.status === "canceled";
  const max = Math.min(MAX_BET_POINTS, balance);
  return (
    <ViewerPredictionCard
      predictionId={p.id}
      status={p.status}
      title={p.title}
      heading={settled ? t("chatPrediction.result") : t("chatPrediction.title")}
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
      error={
        refused ? (
          <span data-testid="chat-prediction-refused" data-reason={refused.reason}>
            {t(refused.key)}
          </span>
        ) : undefined
      }
      hint={
        settled && p.result ? (
          <PredictionResult prediction={p} name={name} fmt={fmt} />
        ) : !signedIn ? (
          t("chatPrediction.signIn")
        ) : !isStaff && points !== null && max < 1 && p.status === "active" && !p.myBet ? (
          t("chatPrediction.noPoints", { name })
        ) : undefined
      }
      liveSummary={p.outcomes
        .map((o) => t("chatPrediction.outcomeLive", { title: o.title, points: fmt(o.points), name }))
        .join(" ")}
      toggleLabel={t("chatPrediction.toggle")}
    />
  );
}
