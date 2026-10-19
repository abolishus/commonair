// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { cn } from "@commonair/ui/lib/utils";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { Timeline, type TimelineUpdate } from "../data/timeline.tsx";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";

export interface IncidentCardProps extends Omit<React.ComponentProps<"div">, "title" | "children"> {
  /** Current state in words ("Monitoring", "Resolved"). */
  status: string;
  tone?: StatusTone;
  title: React.ReactNode;
  /** When it started (`RelativeTime` or pre-formatted text). */
  date: React.ReactNode;
  /** A one-line summary for closed incidents. */
  note?: React.ReactNode;
  /** A follow-up link after the note ("Postmortem"). */
  link?: LinkTarget & { label: string };
  /** Status updates, newest first. */
  updates?: TimelineUpdate[];
  headingLevel?: 2 | 3 | 4;
}

/** A status-page incident: state, title, date, a summary or postmortem link, and its update timeline. */
export function IncidentCard({
  status,
  tone = "warning",
  title,
  date,
  note,
  link,
  updates,
  headingLevel = 3,
  className,
  ...props
}: IncidentCardProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <Card size="sm" data-incident="" className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>
          <Heading className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={tone}>{status}</StatusBadge>
            <span className="min-w-0">{title}</span>
          </Heading>
        </CardTitle>
        {note || link ? (
          <CardDescription>
            {note}
            {note && link ? " " : null}
            {link ? (
              <TargetLink target={link} className="underline underline-offset-4">
                {link.label}
              </TargetLink>
            ) : null}
          </CardDescription>
        ) : null}
        <CardAction className="text-muted-foreground">{date}</CardAction>
      </CardHeader>
      {updates?.length ? (
        <CardContent>
          <Timeline updates={updates} />
        </CardContent>
      ) : null}
    </Card>
  );
}
