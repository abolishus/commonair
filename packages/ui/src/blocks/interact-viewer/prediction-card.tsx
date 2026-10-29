// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { ArrowDown01Icon, Award01Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { Input } from "@commonair/ui/components/input";
import { cn } from "@commonair/ui/lib/utils";
import { CardNote, ShareBar } from "./share-bar.tsx";
import { percentOf, useThrottledValue } from "./throttle.ts";

export type ViewerPredictionStatus = "active" | "locked" | "resolved" | "canceled";

export interface ViewerPredictionOutcome {
  id: string;
  title: string;
  /** Channel points bet on it. */
  points: number;
  /** How many viewers bet on it. */
  users: number;
  /** "1,200 points · 3 viewers". */
  summary: string;
  /** The bet button's text ("Bet on Alpha"). */
  betLabel: string;
  winner?: boolean;
}

export interface ViewerPredictionAmount {
  value: string;
  onValueChange: (value: string) => void;
  min: number;
  max: number;
  /** The field's label ("Points to bet"). */
  label: string;
  invalid?: boolean;
}

export interface ViewerPredictionCardProps extends Omit<React.ComponentProps<"section">, "title"> {
  predictionId: string;
  status: ViewerPredictionStatus;
  title: string;
  outcomes: ViewerPredictionOutcome[];
  heading: string;
  /** The countdown to the lock, "Betting closed", or the result. */
  meta?: React.ReactNode;
  /** The amount field and bet buttons: active, signed in, not the channel's own staff, not yet bet. */
  canBet: boolean;
  amount?: ViewerPredictionAmount | null;
  onBet?: (outcomeId: string) => void;
  /** Disables the bet buttons while a bet is in flight or the amount is out of bounds. */
  betDisabled?: boolean;
  /** The viewer's bet; `payout` stays null until the prediction resolves. */
  myBet: { outcomeId: string; points: number; payout: number | null; label: React.ReactNode } | null;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  liveSummary: string;
  announceMs?: number;
  toggleLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A prediction pinned above the chat log (`chat-prediction`, docs/testing/e8-selectors.md):
 * outcomes with their points and bettors (`chat-prediction-outcome`), the amount field
 * (`chat-prediction-amount`), one bet button per outcome (`chat-prediction-bet-<outcomeId>`) and
 * the viewer's bet (`chat-prediction-my-bet`). Every string comes from the caller.
 */
export function ViewerPredictionCard({
  predictionId,
  status,
  title,
  outcomes,
  heading,
  meta,
  canBet,
  amount,
  onBet,
  betDisabled = false,
  myBet,
  error,
  hint,
  liveSummary,
  announceMs = 5_000,
  toggleLabel,
  open,
  onOpenChange,
  className,
  ...props
}: ViewerPredictionCardProps): React.JSX.Element {
  const total = outcomes.reduce((sum, o) => sum + Math.max(0, o.points), 0);
  const announced = useThrottledValue(liveSummary, announceMs);
  const contentId = React.useId();
  const betting = canBet && status === "active" && myBet === null;
  return (
    <section
      data-testid="chat-prediction"
      data-prediction-id={predictionId}
      data-status={status}
      aria-label={heading}
      className={cn("grid gap-2 text-xs", className)}
      {...props}
    >
      <Collapsible open={open} onOpenChange={onOpenChange} defaultOpen>
        <div className="flex min-w-0 items-start gap-2">
          <HugeiconsIcon
            icon={Target02Icon}
            strokeWidth={2}
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-primary"
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
            <p className="min-w-0 font-semibold break-words">{title}</p>
            {meta ? <p className="text-muted-foreground">{meta}</p> : null}
          </div>
          <CollapsibleTrigger
            aria-controls={contentId}
            render={
              <Button type="button" variant="ghost" size="icon-xs" aria-label={toggleLabel} className="group">
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  strokeWidth={2}
                  aria-hidden
                  className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                />
              </Button>
            }
          />
        </div>
        <CollapsibleContent id={contentId} className="mt-2 grid gap-2">
          <ul className="grid gap-1.5">
            {outcomes.map((outcome) => {
              const mine = myBet?.outcomeId === outcome.id;
              return (
                <li
                  key={outcome.id}
                  data-testid="chat-prediction-outcome"
                  data-outcome-id={outcome.id}
                  data-points={outcome.points}
                  data-users={outcome.users}
                  data-winner={outcome.winner ? "true" : undefined}
                  className="grid gap-1"
                >
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1 font-medium break-words">
                      {outcome.winner ? (
                        <HugeiconsIcon
                          icon={Award01Icon}
                          strokeWidth={2}
                          aria-hidden
                          className="size-3.5 text-success"
                        />
                      ) : null}
                      {outcome.title}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{outcome.summary}</span>
                  </div>
                  <ShareBar
                    label={outcome.title}
                    percent={percentOf(outcome.points, total)}
                    emphasis={mine || outcome.winner === true}
                  />
                  {betting ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-testid={`chat-prediction-bet-${outcome.id}`}
                      disabled={betDisabled}
                      onClick={() => onBet?.(outcome.id)}
                      className="justify-self-start"
                    >
                      {outcome.betLabel}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {betting && amount ? (
            <Input
              type="number"
              inputMode="numeric"
              min={amount.min}
              max={amount.max}
              step={1}
              value={amount.value}
              aria-label={amount.label}
              placeholder={amount.label}
              aria-invalid={amount.invalid || undefined}
              data-testid="chat-prediction-amount"
              onChange={(e) => amount.onValueChange(e.currentTarget.value)}
              className="w-full"
            />
          ) : null}
          {myBet ? (
            <p
              data-testid="chat-prediction-my-bet"
              data-outcome-id={myBet.outcomeId}
              data-points={myBet.points}
              data-payout={myBet.payout ?? ""}
              className="text-muted-foreground"
            >
              {myBet.label}
            </p>
          ) : null}
          {error ? <CardNote tone="error">{error}</CardNote> : null}
          {hint ? <CardNote tone="hint">{hint}</CardNote> : null}
        </CollapsibleContent>
      </Collapsible>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
    </section>
  );
}
