// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { ArrowDown01Icon, ChartHistogramIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { Input } from "@commonair/ui/components/input";
import { cn } from "@commonair/ui/lib/utils";
import { CardNote, ShareBar } from "./share-bar.tsx";
import { percentOf, useThrottledValue } from "./throttle.ts";

export type ViewerPollStatus = "active" | "completed" | "terminated" | "archived";

export interface ViewerPollChoice {
  id: string;
  title: string;
  /** Every vote, bought extra votes included. */
  votes: number;
  /** The count as the viewer reads it ("3 votes"). */
  votesLabel: string;
}

export interface ViewerPollExtra {
  value: number;
  max: number;
  onValueChange: (value: number) => void;
  /** The field's label ("Extra votes"). */
  label: string;
  /** What the extra votes cost, in channel points ("20 points"). */
  costLabel: string;
}

export interface ViewerPollCardProps extends Omit<React.ComponentProps<"section">, "title"> {
  pollId: string;
  status: ViewerPollStatus;
  title: string;
  choices: ViewerPollChoice[];
  /** "Poll" while active, "Poll results" once ended. */
  heading: string;
  /** Under the title: the countdown or the total ("ends in 12 s · 7 votes"). */
  meta?: React.ReactNode;
  /** The viewer's choice and votes, once voted. */
  myVote: { choiceId: string; votes: number; label: string } | null;
  /** Signed in, the poll active and nothing in flight. */
  canVote: boolean;
  onVote?: (choiceId: string) => void;
  /** The extra-votes field (channel points), when the poll sells them and points are on. */
  extra?: ViewerPollExtra | null;
  error?: React.ReactNode;
  /** Shown instead of voting controls (signed-out viewers). */
  hint?: React.ReactNode;
  /** One sentence with every choice's count, announced politely and at most every `announceMs`. */
  liveSummary: string;
  announceMs?: number;
  /** The collapse toggle's accessible name ("Show or hide the poll"). */
  toggleLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A poll pinned above the chat log (`chat-poll`, docs/testing/e8-selectors.md): one button per
 * choice (`chat-poll-choice`) with its share bar, the viewer's vote (`chat-poll-voted`) and the
 * extra-votes field (`chat-poll-extra`). Collapsible; every string comes from the caller.
 */
export function ViewerPollCard({
  pollId,
  status,
  title,
  choices,
  heading,
  meta,
  myVote,
  canVote,
  onVote,
  extra,
  error,
  hint,
  liveSummary,
  announceMs = 5_000,
  toggleLabel,
  open,
  onOpenChange,
  className,
  ...props
}: ViewerPollCardProps): React.JSX.Element {
  const total = choices.reduce((sum, c) => sum + Math.max(0, c.votes), 0);
  const announced = useThrottledValue(liveSummary, announceMs);
  const active = status === "active";
  const extraVotes = extra?.value ?? 0;
  const contentId = React.useId();
  return (
    <section
      data-testid="chat-poll"
      data-poll-id={pollId}
      data-status={status}
      aria-label={heading}
      className={cn("grid gap-2 text-xs", className)}
      {...props}
    >
      <Collapsible open={open} onOpenChange={onOpenChange} defaultOpen>
        <div className="flex min-w-0 items-start gap-2">
          <HugeiconsIcon
            icon={ChartHistogramIcon}
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
            {choices.map((choice) => {
              const mine = myVote?.choiceId === choice.id;
              // A second click on one's own choice buys extra votes; other choices stay closed.
              const enabled = canVote && (myVote === null || (mine && extraVotes > 0));
              const percent = percentOf(choice.votes, total);
              return (
                <li key={choice.id} className="grid gap-1">
                  <Button
                    type="button"
                    variant={mine ? "secondary" : "outline"}
                    size="sm"
                    data-testid="chat-poll-choice"
                    data-choice-id={choice.id}
                    data-votes={choice.votes}
                    aria-pressed={mine}
                    disabled={!enabled}
                    onClick={() => onVote?.(choice.id)}
                    className="h-auto min-h-7 w-full justify-between gap-2 py-1 text-start whitespace-normal"
                  >
                    <span className="min-w-0 break-words">{choice.title}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {choice.votesLabel} · {percent}%
                    </span>
                  </Button>
                  <ShareBar label={choice.title} percent={percent} emphasis={mine || !active} />
                </li>
              );
            })}
          </ul>
          {myVote ? (
            <p
              data-testid="chat-poll-voted"
              data-choice-id={myVote.choiceId}
              data-votes={myVote.votes}
              className="text-muted-foreground"
            >
              {myVote.label}
            </p>
          ) : null}
          {extra && active && canVote ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={extra.max}
                step={1}
                value={String(extra.value)}
                aria-label={extra.label}
                data-testid="chat-poll-extra"
                onChange={(e) => {
                  const n = Math.trunc(Number(e.currentTarget.value));
                  extra.onValueChange(Number.isFinite(n) ? Math.max(0, Math.min(extra.max, n)) : 0);
                }}
                className="w-20"
              />
              <span className="text-muted-foreground">
                {extra.label} · {extra.costLabel}
              </span>
            </div>
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
