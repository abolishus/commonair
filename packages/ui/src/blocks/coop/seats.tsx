// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { ChannelAvatar, type Accent } from "../../primitives/channel-avatar.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { KeyValueList, type KeyValueRow } from "../data/key-value-list.tsx";
import { electionStatusTone } from "./tones.ts";

export interface SeatListItem {
  /** Set as `data-user-id`. */
  userId: string;
  name: string;
  accent?: Accent | null;
  avatarUrl?: string | null;
  /** Profile or channel page. */
  link?: LinkTarget;
  /** Council rank (`data-rank`). */
  rank?: number;
  /** Contribution score (`data-score`). */
  score?: number;
  /** Member class of a board seat (`data-class`). */
  memberClass?: string;
  /** "Rank 1 · score 41.2", "Streamer seat · until Mar 2027". */
  description?: React.ReactNode;
  /** A badge or text at the end ("Chair"). */
  trailing?: React.ReactNode;
}

export interface SeatListProps extends Omit<React.ComponentProps<"div">, "children"> {
  items: readonly SeatListItem[];
  /** Accessible name of the list. */
  label: string;
  empty?: React.ReactNode;
  /** Set on every seat besides its `data-*` (e.g. `council-member`, `board-seat`). */
  itemProps?: DataAttributes;
}

/** Council or board seats: avatar, name, rank/score or class, and an optional trailing badge. */
export function SeatList({ items, label, empty, itemProps, className, ...props }: SeatListProps): React.JSX.Element {
  if (items.length === 0 && empty) return <>{empty}</>;
  return (
    <ItemGroup aria-label={label} className={cn("gap-2", className)} {...props}>
      {items.map((item) => (
        <Item
          {...itemProps}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
          role="listitem"
          key={`${item.userId}-${item.memberClass ?? ""}`}
          variant="outline"
          size="sm"
          data-user-id={item.userId}
          data-rank={item.rank}
          data-score={item.score}
          data-class={item.memberClass}
        >
          <ItemMedia>
            <ChannelAvatar name={item.name} src={item.avatarUrl} accent={item.accent} size="sm" decorative />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="wrap-anywhere">
              {item.link ? (
                <TargetLink target={item.link} className="hover:underline hover:underline-offset-4">
                  {item.name}
                </TargetLink>
              ) : (
                item.name
              )}
            </ItemTitle>
            {item.description ? <ItemDescription>{item.description}</ItemDescription> : null}
          </ItemContent>
          {item.trailing ? <ItemActions>{item.trailing}</ItemActions> : null}
        </Item>
      ))}
    </ItemGroup>
  );
}

export interface ElectionCandidate {
  userId: string;
  name: string;
  accent?: Accent | null;
  statement?: React.ReactNode;
  /** Shown once counted ("41 votes"); omit while voting. */
  votes?: React.ReactNode;
  elected: boolean;
}

export interface ElectionCardProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  /** Set as `data-election-id`. */
  electionId: string;
  /** `MEMBER_CLASSES` value; set as `data-class`. */
  memberClass: string;
  /** `ELECTION_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Seats, nominations close, voting ends. */
  details?: readonly KeyValueRow[];
  candidates: readonly ElectionCandidate[];
  labels: { candidates: string; elected: string; noCandidates?: React.ReactNode };
}

/** A board election, read-only: status, dates and candidates (elected ones marked). */
export function ElectionCard({
  electionId,
  memberClass,
  status,
  statusLabel,
  title,
  description,
  details,
  candidates,
  labels,
  className,
  ...props
}: ElectionCardProps): React.JSX.Element {
  return (
    <Card
      size="sm"
      data-election-id={electionId}
      data-class={memberClass}
      data-status={status}
      className={cn("min-w-0", className)}
      {...props}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <CardAction>
          <StatusBadge tone={electionStatusTone(status)}>{statusLabel}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {details?.length ? <KeyValueList dense rows={[...details]} /> : null}
        <h3 className="text-xs font-medium">{labels.candidates}</h3>
        {candidates.length === 0 ? (
          labels.noCandidates ? (
            <p className="text-xs text-muted-foreground">{labels.noCandidates}</p>
          ) : null
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <li key={candidate.userId} data-user-id={candidate.userId} className="flex min-w-0 items-start gap-2">
                <ChannelAvatar name={candidate.name} accent={candidate.accent} size="xs" decorative />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="wrap-anywhere">{candidate.name}</span>
                    {candidate.elected ? (
                      <StatusBadge tone="success" icon={Tick02Icon}>
                        {labels.elected}
                      </StatusBadge>
                    ) : null}
                  </span>
                  {candidate.statement ? <span className="text-muted-foreground">{candidate.statement}</span> : null}
                </div>
                {candidate.votes ? <span className="shrink-0 text-xs tabular-nums">{candidate.votes}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
