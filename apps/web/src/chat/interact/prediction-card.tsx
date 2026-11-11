// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, formatNumber, useLocale } from "@commonair/ui";
import { ViewerPredictionCard } from "@commonair/ui/blocks/interact-viewer";
import { Button } from "@commonair/ui/components/button";
import { Input } from "@commonair/ui/components/input";
import { Progress, ProgressLabel } from "@commonair/ui/components/progress";
import * as React from "react";
import { PredictionSignUpPrompt } from "../../components/auth-gate/chat-prompt.tsx";
import { type MessageKey, t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorReason, errorRequirement } from "../../lib/coop.ts";
import { playbackMode, playheadWallclock } from "../../player/media-clock.ts";
import { displayPointsName } from "./points-chip.tsx";
import { type InteractClient, type PlayheadClock, interactErrorKey, isStaffRefusal } from "./client.ts";
import { MAX_BET_POINTS, betAmount, type LoyaltyBalanceDto, type PredictionViewDto } from "./state.ts";

/** The channel a prediction runs on, as the channel page knows it (batch 8 contract step §3.8). */
export interface PredictionChannel {
  id: string;
  /** Whether the channel is live now: the grace window after a lock is offered only while it is. */
  live: boolean;
  /** The channel's slug, whose player (`player/media-clock.ts`) says where the viewer is; absent = no grace. */
  slug?: string;
}

/** ADR 0039 §3: after the lock, a bet on what the viewer saw is taken for 30 s of wall clock. */
export const GRACE_MS = 30_000;

/** When the grace after this prediction's lock ends (epoch ms), or null when it has none. */
export function graceEndsAt(p: Pick<PredictionViewDto, "status" | "lockedAt" | "lockMediaTs">): number | null {
  if (p.status !== "locked" || !p.lockedAt || !p.lockMediaTs) return null;
  const lockedAt = Date.parse(p.lockedAt);
  return Number.isFinite(lockedAt) ? lockedAt + GRACE_MS : null;
}

/**
 * Whether the card offers a bet in the grace after the lock. Only for a live channel (an offline
 * prediction has no media-time lock, so no grace), within 30 s of `lockedAt` by the wall clock now
 * (recomputed on every tick, never from when a local timer started), and only while this viewer's
 * player is live (`dvr` cannot bet) with its playhead before `lockMediaTs`. The server judges every
 * bet again: this only decides whether to offer one. Pure.
 */
export function graceOpen(s: {
  prediction: Pick<PredictionViewDto, "status" | "lockedAt" | "lockMediaTs" | "myBet">;
  channel: PredictionChannel | null | undefined;
  nowMs: number;
  mode: "live" | "dvr";
  playhead: Date | null;
}): boolean {
  const ends = graceEndsAt(s.prediction);
  if (ends === null || s.prediction.myBet !== null) return false;
  if (!s.channel?.live || !s.channel.slug) return false;
  if (s.nowMs >= ends || s.mode !== "live" || s.playhead === null) return false;
  const lock = Date.parse(s.prediction.lockMediaTs ?? "");
  return Number.isFinite(lock) && s.playhead.getTime() < lock;
}

const MEDIA_CLOCK: PlayheadClock = { playheadWallclock, playbackMode };

/**
 * Re-reads the wall clock (and so the player) every second until `until`, and at once when the tab
 * is shown again; null = no grace to watch.
 */
function useGraceTick(until: number | null, now: () => number): number {
  const [tick, setTick] = React.useState(now);
  React.useEffect(() => {
    if (until === null) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      const at = now();
      setTick(at);
      if (at >= until) clearInterval(timer);
    };
    timer = setInterval(update, 1_000);
    update();
    // A hidden tab's timers are throttled: recompute the moment it is shown again.
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [until, now]);
  return tick;
}

export interface ChatPredictionCardProps {
  prediction: PredictionViewDto;
  /**
   * The channel and its live state, or null where the page does not know them. With its slug, the
   * card offers the grace after a lock (W3-fair-predictions request 3, ADR 0039 §3).
   */
  channel?: PredictionChannel | null;
  /** Where the grace reads this channel's player; tests pass a fake. */
  clock?: PlayheadClock;
  /** The wall clock (ms); tests pass a fake. */
  now?: () => number;
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
  channel,
  clock = MEDIA_CLOCK,
  now = Date.now,
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
  // A refusal in the grace closes its form for good: the server has said no for this lock.
  const [graceClosed, setGraceClosed] = React.useState(false);
  // Whether the card's amount field was the last thing focused: at the lock it unmounts, and the
  // grace form's field takes the keyboard focus over (a removed element fires no reliable blur).
  const amountFocused = React.useRef(false);
  React.useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target;
      amountFocused.current =
        el instanceof HTMLElement &&
        el.dataset.testid === "chat-prediction-amount" &&
        el.closest(`[data-prediction-id="${CSS.escape(p.id)}"]`) !== null;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [p.id]);

  const balance = points?.points ?? 0;
  const name = displayPointsName(points?.pointsName);
  const fmt = (n: number) => formatNumber(n, locale);
  const value = betAmount(amount, balance);
  const isStaff = staff || refusedStaff;

  const bet = async (outcomeId: string, grace = false) => {
    if (value === null) return;
    setPending(true);
    setRefused(null);
    try {
      // `client` carries the playhead and playback mode (`withPlayhead`), as for any bet.
      const view = await client.bet({ id: p.id, outcomeId, points: value });
      onBet(view);
      setAmount("");
      onPointsSpent();
    } catch (err) {
      // A ban or timeout is FORBIDDEN too, and ends; only a staff refusal hides betting for good.
      if (isStaffRefusal(err)) setRefusedStaff(true);
      if (grace) setGraceClosed(true);
      setRefused({ reason: betRefusalReason(err), key: betRefusalMessage(err) });
    } finally {
      setPending(false);
    }
  };

  const endsAt = graceEndsAt(p);
  const tick = useGraceTick(!graceClosed && channel?.live === true && p.myBet === null ? endsAt : null, now);
  const nowMs = Math.max(tick, now());
  const slug = channel?.slug;
  const inGrace =
    !graceClosed &&
    graceOpen({
      prediction: p,
      channel,
      nowMs,
      mode: slug ? clock.playbackMode(slug) : "live",
      playhead: slug ? clock.playheadWallclock(slug) : null,
    });

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
  const canBet = signedIn && !isStaff && points !== null && max >= 1;
  const card = (
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
      canBet={canBet}
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
          <PredictionSignUpPrompt />
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
  if (!inGrace || !canBet || endsAt === null) return card;
  return (
    <>
      {card}
      <GraceBet
        prediction={p}
        endsAt={endsAt}
        nowMs={nowMs}
        amount={amount}
        onAmountChange={setAmount}
        invalid={amount.trim() !== "" && value === null}
        max={Math.max(1, max)}
        name={name}
        disabled={pending || value === null}
        onBet={(id) => void bet(id, true)}
        takeFocus={amountFocused}
      />
    </>
  );
}

/**
 * The grace bet (`prediction-grace`): a countdown to 30 s after the lock and one bet button per
 * outcome, for a viewer whose live player has not reached the lock yet. Its amount field and bet
 * buttons keep the card's own test ids (`chat-prediction-amount`, `chat-prediction-bet-<id>`),
 * which the card no longer renders once locked. The bar follows the global
 * `prefers-reduced-motion` rule (no transition), and the countdown is not announced every second.
 */
function GraceBet({
  prediction: p,
  endsAt,
  nowMs,
  amount,
  onAmountChange,
  invalid,
  max,
  name,
  disabled,
  onBet,
  takeFocus,
}: {
  prediction: PredictionViewDto;
  endsAt: number;
  nowMs: number;
  amount: string;
  onAmountChange: (v: string) => void;
  invalid: boolean;
  max: number;
  name: string;
  disabled: boolean;
  onBet: (outcomeId: string) => void;
  /** True when the card's amount field had the focus as the lock removed it. */
  takeFocus: React.RefObject<boolean>;
}): React.JSX.Element {
  const headingId = React.useId();
  const amountRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const active = document.activeElement;
    if (takeFocus.current && (active === null || active === document.body)) amountRef.current?.focus();
    // The ref object is stable, so this runs once, on mount: only the lock's unmount strands the focus.
  }, [takeFocus]);
  const left = Math.min(GRACE_MS, Math.max(0, endsAt - nowMs));
  const seconds = Math.ceil(left / 1000);
  return (
    <section
      data-testid="prediction-grace"
      data-prediction-id={p.id}
      data-grace-ends-at={new Date(endsAt).toISOString()}
      aria-labelledby={headingId}
      className="grid gap-2 border-t pt-2 text-xs"
    >
      <p id={headingId} className="font-medium">
        {t("fairPrediction.grace.title")}
      </p>
      <p className="text-muted-foreground">{t("fairPrediction.grace.note")}</p>
      <Progress value={Math.round((left / GRACE_MS) * 100)} className="gap-1">
        <ProgressLabel data-testid="prediction-grace-countdown" data-seconds={seconds} className="tabular-nums">
          {t("fairPrediction.grace.countdown", { seconds })}
        </ProgressLabel>
      </Progress>
      <Input
        ref={amountRef}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={amount}
        aria-label={t("chatPrediction.amount", { name })}
        placeholder={t("chatPrediction.amount", { name })}
        aria-invalid={invalid || undefined}
        data-testid="chat-prediction-amount"
        onChange={(e) => onAmountChange(e.currentTarget.value)}
        className="w-full"
      />
      <div className="flex flex-wrap gap-2">
        {p.outcomes.map((o) => (
          <Button
            key={o.id}
            type="button"
            variant="outline"
            size="xs"
            data-testid={`chat-prediction-bet-${o.id}`}
            disabled={disabled}
            onClick={() => onBet(o.id)}
          >
            {t("chatPrediction.bet", { outcome: o.title })}
          </Button>
        ))}
      </div>
    </section>
  );
}
