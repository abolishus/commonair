// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { Item, ItemContent, ItemFooter, ItemGroup, ItemMedia, ItemTitle } from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import { ChannelAvatar, type Accent } from "../../primitives/channel-avatar.tsx";

export interface CommentAction {
  id: string;
  /** Visible text ("Helpful · 38", "Reply"). */
  label: string;
  onAction?: () => void;
  /** For toggles such as "Helpful": the pressed state. */
  pressed?: boolean;
}

export interface CommentItemProps extends Omit<React.ComponentProps<"div">, "children"> {
  author: string;
  accent?: Accent | null;
  avatarUrl?: string | null;
  /** A short role chip after the name ("Streamer member"). */
  badge?: string;
  /** When it was posted (`RelativeTime` or pre-formatted text). */
  time: React.ReactNode;
  children: React.ReactNode;
  actions?: CommentAction[];
}

/** One comment in a discussion (proposal threads): author, member class, time, text and actions. */
export function CommentItem({
  author,
  accent,
  avatarUrl,
  badge,
  time,
  children,
  actions,
  className,
  ...props
}: CommentItemProps): React.JSX.Element {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
    <Item role="listitem" size="sm" className={cn("min-w-0", className)} {...props}>
      <ItemMedia>
        <ChannelAvatar name={author} src={avatarUrl} accent={accent} size="sm" decorative />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none w-full min-w-0 flex-wrap">
          <span className="min-w-0 wrap-anywhere">{author}</span>
          {badge ? <Badge variant="outline">{badge}</Badge> : null}
          <span className="font-normal text-muted-foreground">{time}</span>
        </ItemTitle>
        <div className="text-xs/relaxed wrap-anywhere">{children}</div>
      </ItemContent>
      {actions?.length ? (
        <ItemFooter className="justify-start gap-1">
          {actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={action.pressed}
              onClick={action.onAction}
            >
              {action.label}
            </Button>
          ))}
        </ItemFooter>
      ) : null}
    </Item>
  );
}

export interface CommentListProps extends React.ComponentProps<"div"> {
  /** Accessible name of the list ("Comments"). */
  label: string;
}

/** The list around `CommentItem`s: shadcn `ItemGroup` (`role="list"`) with an accessible name. */
export function CommentList({ label, ...props }: CommentListProps): React.JSX.Element {
  return <ItemGroup aria-label={label} {...props} />;
}
