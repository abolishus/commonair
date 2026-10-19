// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { cn } from "@commonair/ui/lib/utils";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { ProgressRow } from "./progress-row.tsx";

export interface ProposalProgress {
  /** Accessible and visible label ("Ends Oct 24 · 214 comments"). */
  label: string;
  /** Turnout, 0–100. */
  value: number;
  valueText: React.ReactNode;
  /** E.g. "You voted". */
  note?: React.ReactNode;
}

export interface ProposalCardProps extends Omit<React.ComponentProps<"div">, "title" | "children"> {
  /** Short reference shown before the title ("#47"). */
  reference?: string;
  title: string;
  /** Proposal page: `href` or a router `render` element. */
  link: LinkTarget;
  summary?: React.ReactNode;
  status: string;
  statusTone?: StatusTone;
  /** Shown as a lock badge when the decision is protected (needs every class to pass). */
  protectedLabel?: string;
  progress?: ProposalProgress;
  headingLevel?: 2 | 3 | 4;
}

/** A proposal in a list (co-op "Open for voting"): linked title, status, summary and turnout. */
export function ProposalCard({
  reference,
  title,
  link,
  summary,
  status,
  statusTone = "info",
  protectedLabel,
  progress,
  headingLevel = 3,
  className,
  ...props
}: ProposalCardProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <Card size="sm" data-proposal="" className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>
          <Heading className="flex flex-wrap items-center gap-2">
            <TargetLink target={link} className="min-w-0 hover:underline hover:underline-offset-4">
              {reference ? <span className="tabular-nums">{reference} </span> : null}
              {title}
            </TargetLink>
            {protectedLabel ? (
              <StatusBadge tone="warning" icon={SquareLock01Icon}>
                {protectedLabel}
              </StatusBadge>
            ) : null}
          </Heading>
        </CardTitle>
        {summary ? <CardDescription>{summary}</CardDescription> : null}
        <CardAction>
          <StatusBadge tone={statusTone}>{status}</StatusBadge>
        </CardAction>
      </CardHeader>
      {progress ? (
        <CardContent>
          <ProgressRow
            label={progress.label}
            value={progress.value}
            valueText={progress.valueText}
            note={progress.note}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}
