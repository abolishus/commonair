// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's "Ready to go live" checklist (overhaul wave 3, D5.1; creator-studio.md P1): a
 * numbered list where each step is done, current or still to do. The current step expands inline
 * (`detail`), so the streamer never leaves the page; a done step keeps its summary and an action
 * (Edit), so nothing becomes a dead end. State is never shown by colour alone: a tick or the step
 * number, and a visually hidden state word. Strings come in already translated.
 */
import * as React from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Card } from "@commonair/ui/components/card";
import { Progress } from "@commonair/ui/components/progress";
import { cn } from "@commonair/ui/lib/utils";

export type SetupStepState = "done" | "current" | "todo";

export interface SetupChecklistStep {
  id: string;
  title: string;
  state: SetupStepState;
  /** What to do, shown while the step is not done. */
  hint?: React.ReactNode;
  /** What was done ("Harbor Lights · picture added"), shown once it is. */
  summary?: React.ReactNode;
  /** A time estimate ("About 2 min"), shown while not done. */
  estimate?: string;
  /** Marked "(optional)" after the title. */
  optional?: boolean;
  /** The step's one action (a button or link); a done step's is usually Edit. */
  action?: React.ReactNode;
  /** Shown under the step while it is current. */
  detail?: React.ReactNode;
}

export interface SetupChecklistLabels {
  /** The visually hidden state words. */
  done: string;
  current: string;
  todo: string;
  /** "(optional)". */
  optional: string;
  /** The progress bar's accessible name ("Setup progress"). */
  progress: string;
}

export interface SetupChecklistProps extends Omit<React.ComponentProps<"section">, "title"> {
  title: string;
  /** "2 of 6 steps done", already translated. */
  progressText: string;
  done: number;
  total: number;
  steps: readonly SetupChecklistStep[];
  labels: SetupChecklistLabels;
  /** Under the list ("Support is on from your first stream"). */
  footer?: React.ReactNode;
  headingLevel?: 2 | 3;
}

export function SetupChecklist({
  title,
  progressText,
  done,
  total,
  steps,
  labels,
  footer,
  headingLevel = 2,
  className,
  ...props
}: SetupChecklistProps): React.JSX.Element {
  const headingId = React.useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const percent = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0;
  return (
    <section aria-labelledby={headingId} data-slot="setup-checklist" className={cn("min-w-0", className)} {...props}>
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-4 py-4 sm:px-6">
          <div className="min-w-0 grow">
            <Heading id={headingId} className="font-display text-lg font-semibold">
              {title}
            </Heading>
            <p className="text-sm text-muted-foreground tabular-nums" data-slot="setup-checklist-progress">
              {progressText}
            </p>
          </div>
          <Progress value={percent} aria-label={labels.progress} className="w-full sm:w-48" />
        </div>
        <ol className="flex flex-col">
          {steps.map((step, index) => (
            <SetupChecklistItem key={step.id} step={step} number={index + 1} labels={labels} />
          ))}
        </ol>
        {footer ? <div className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-6">{footer}</div> : null}
      </Card>
    </section>
  );
}

function SetupChecklistItem({
  step,
  number,
  labels,
}: {
  step: SetupChecklistStep;
  number: number;
  labels: SetupChecklistLabels;
}): React.JSX.Element {
  const isDone = step.state === "done";
  const isCurrent = step.state === "current";
  return (
    <li
      data-step={step.id}
      data-state={step.state}
      aria-current={isCurrent ? "step" : undefined}
      className={cn("border-b px-4 py-4 last:border-b-0 sm:px-6", isCurrent && "bg-muted/40")}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
              isDone && "border-success text-success",
              isCurrent && "border-foreground text-foreground",
              step.state === "todo" && "text-muted-foreground",
            )}
          >
            {isDone ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-3.5" /> : number}
          </span>
          <div className="min-w-0">
            <p className={cn("font-medium", isDone && "text-muted-foreground")}>
              <span className="sr-only">{`${isDone ? labels.done : isCurrent ? labels.current : labels.todo}: `}</span>
              {step.title}
              {step.optional ? (
                <span className="font-normal text-muted-foreground">{` ${labels.optional}`}</span>
              ) : null}
            </p>
            {isDone ? (
              step.summary ? (
                <p className="text-sm text-muted-foreground">{step.summary}</p>
              ) : null
            ) : step.hint ? (
              <p className="text-sm text-muted-foreground">{step.hint}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {!isDone && step.estimate ? (
            <span className="text-xs text-muted-foreground tabular-nums" data-slot="setup-step-estimate">
              {step.estimate}
            </span>
          ) : null}
          {step.action}
        </div>
      </div>
      {isCurrent && step.detail ? <div className="mt-4 min-w-0 sm:ps-9">{step.detail}</div> : null}
    </li>
  );
}
