// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { ProgressRow } from "../data/progress-row.tsx";
import { OptionGroup } from "../forms/option-card.tsx";

export interface VoteParticipationProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** How many of the frozen electorate voted. */
  voted: number;
  eligible: number;
  /** "Participation". */
  label: string;
  /** "12 of 40 members voted". */
  valueText: React.ReactNode;
  note?: React.ReactNode;
}

/**
 * Participation in an open vote: voted of eligible, nothing else. It takes no yes/no counts on
 * purpose (secret ballot: no running tally before the decision).
 */
export function VoteParticipation({
  voted,
  eligible,
  label,
  valueText,
  note,
  className,
  ...props
}: VoteParticipationProps): React.JSX.Element {
  const percent = eligible > 0 ? (voted / eligible) * 100 : 0;
  return (
    <div data-voted={voted} data-eligible={eligible} className={cn("min-w-0", className)} {...props}>
      <ProgressRow label={label} value={percent} valueText={valueText} note={note} />
    </div>
  );
}

export interface VoteChoiceOption {
  /** `yes`, `no` or `abstain`. */
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

export interface VotePanelProps extends Omit<React.ComponentProps<"div">, "children" | "title" | "onSubmit"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Accessible name of the choice group ("Your vote"). */
  choiceLabel: string;
  choices: readonly VoteChoiceOption[];
  /** The caller's recorded vote (`myVote`), or null. Pre-selects the choice; set as `data-my-vote`. */
  myVote: string | null;
  /** E.g. "You voted yes. You can change it until voting closes." Shown when `myVote` is set. */
  myVoteText?: React.ReactNode;
  /** Controlled choice; defaults to an internal state seeded from `myVote`. */
  value?: string;
  onValueChange?: (value: string) => void;
  canVote: boolean;
  /** Why the caller cannot vote (not in the electorate, signed out, closed). Shown when `canVote` is false. */
  cannotVoteReason?: React.ReactNode;
  submitLabel: string;
  onSubmit: (choice: string) => void | Promise<void>;
  /** While the vote is being recorded. */
  pending?: boolean;
  /** Under the choices, e.g. `<VoteParticipation>`. Never a running tally. */
  participation?: React.ReactNode;
  /** Set on the choice radio group (e.g. `{ "data-testid": "vote-choice" }`). */
  groupProps?: { "data-testid"?: string };
  /** Per choice, set on its radio (e.g. `vote-choice-yes`). */
  choiceProps?: (value: string) => DataAttributes;
  submitProps?: DataAttributes;
}

/** The ballot of a proposal in `voting`: yes / no / abstain, the caller's vote, or why they cannot vote. */
export function VotePanel({
  title,
  description,
  choiceLabel,
  choices,
  myVote,
  myVoteText,
  value,
  onValueChange,
  canVote,
  cannotVoteReason,
  submitLabel,
  onSubmit,
  pending = false,
  participation,
  groupProps,
  choiceProps,
  submitProps,
  className,
  ...props
}: VotePanelProps): React.JSX.Element {
  const [inner, setInner] = React.useState(myVote ?? "");
  const current = value ?? inner;
  const reasonId = React.useId();
  const select = (next: string): void => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };
  const blocked = !canVote;
  return (
    <Card data-my-vote={myVote ?? ""} data-can-vote={String(canVote)} className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <OptionGroup
          {...groupProps}
          aria-label={choiceLabel}
          items={choices.map((choice) => ({
            value: choice.value,
            title: choice.label,
            description: choice.description,
            disabled: blocked || pending,
            controlProps: choiceProps?.(choice.value),
          }))}
          value={current}
          onValueChange={select}
          className="flex flex-col gap-2"
        />
        {blocked && cannotVoteReason ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {cannotVoteReason}
          </p>
        ) : null}
        {!blocked && myVote && myVoteText ? <p className="text-xs text-muted-foreground">{myVoteText}</p> : null}
        {participation}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          {...submitProps}
          type="button"
          size="sm"
          disabled={blocked || pending || !current}
          aria-describedby={blocked && cannotVoteReason ? reasonId : undefined}
          aria-busy={pending || undefined}
          onClick={() => {
            if (current) void onSubmit(current);
          }}
        >
          {submitLabel}
        </Button>
      </CardFooter>
    </Card>
  );
}
