// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { cn } from "@commonair/ui/lib/utils";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";

export interface QueueItemAction {
  id: string;
  label: string;
  variant?: "default" | "outline" | "destructive" | "ghost";
  onAction?: () => void;
  buttonProps?: Omit<React.ComponentProps<typeof Button>, "variant" | "size" | "onClick" | "children"> & {
    [key: `data-${string}`]: string | undefined;
  };
}

export interface QueueItemCardProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Why it is in the queue ("Held by filter", "Reported"). */
  kind: string;
  tone?: StatusTone;
  /** The specific reason ("Link from a new account"). */
  reason: React.ReactNode;
  /** When it arrived (`RelativeTime` or pre-formatted text). */
  time: React.ReactNode;
  /** The held content, usually a `ChatMessage`. */
  children: React.ReactNode;
  /** Decisions in order (approve, deny, timeout, ban). */
  actions?: QueueItemAction[];
  /** Pushed to the end of the row (e.g. "Escalate to platform"). */
  trailingAction?: QueueItemAction;
  headingLevel?: 2 | 3 | 4;
}

function ActionButton({ action, className }: { action: QueueItemAction; className?: string }): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={action.variant ?? "outline"}
      onClick={action.onAction}
      className={className}
      {...action.buttonProps}
    >
      {action.label}
    </Button>
  );
}

/** One item of a moderation queue: kind, reason and time, the held content, and the decisions. */
export function QueueItemCard({
  kind,
  tone = "warning",
  reason,
  time,
  children,
  actions = [],
  trailingAction,
  headingLevel = 3,
  className,
  ...props
}: QueueItemCardProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  return (
    <Card size="sm" data-queue-item="" className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>
          <Heading className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={tone}>{kind}</StatusBadge>
            <span className="min-w-0">{reason}</span>
          </Heading>
        </CardTitle>
        <CardAction className="text-muted-foreground">{time}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="min-w-0">{children}</div>
        {actions.length || trailingAction ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
            {trailingAction ? <ActionButton action={trailingAction} className="ms-auto" /> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
