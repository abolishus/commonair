// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { ChannelAvatar, LiveBadge, StatusBadge, ViewerCount } from "@commonair/ui";
import type { Accent, LiveBadgeProps } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface ChannelHeaderProps extends React.ComponentProps<"section"> {
  name: string;
  avatarUrl?: string | null;
  accent?: Accent;
  live?: boolean;
  headingLevel?: 1 | 2;
  title?: string;
  category?: React.ReactNode;
  tags?: string[];
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  viewerCount?: number;
  followers?: React.ReactNode;
  lastLive?: React.ReactNode;
  variant?: "live" | "offline" | "vod" | "compact";
  meta?: React.ReactNode;
  offlineLabel?: string;
  /** Forwarded to the live badge shown next to the name. */
  liveBadgeProps?: Partial<LiveBadgeProps> & { [key: `data-${string}`]: string | undefined };
}

export function ChannelHeader({
  name,
  avatarUrl,
  accent,
  live = false,
  headingLevel = 1,
  title,
  category,
  tags = [],
  badges,
  actions,
  viewerCount,
  followers,
  lastLive,
  variant = live ? "live" : "offline",
  meta,
  offlineLabel,
  liveBadgeProps,
  className,
  ...props
}: ChannelHeaderProps): React.JSX.Element {
  const Heading = `h${headingLevel}` as const;
  const compact = variant === "compact";
  return (
    <section className={cn("flex min-w-0 flex-wrap items-center gap-3", compact && "gap-2", className)} {...props}>
      <ChannelAvatar name={name} src={avatarUrl} accent={accent} size={compact ? "md" : "lg"} live={live} decorative />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Heading className="min-w-0 truncate text-base font-semibold">{name}</Heading>
          {live && <LiveBadge pulse {...liveBadgeProps} />}
          {badges}
          {variant === "offline" && offlineLabel && <StatusBadge tone="neutral">{offlineLabel}</StatusBadge>}
        </div>
        {title && <p className="truncate text-sm text-muted-foreground">{title}</p>}
        {(category || tags.length > 0) && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {category}
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
        {(viewerCount !== undefined || followers || lastLive) && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {viewerCount !== undefined && <ViewerCount count={viewerCount} />}
            {followers}
            {lastLive}
          </div>
        )}
      </div>
      {actions && (
        <div className={cn("flex shrink-0 flex-wrap items-center gap-2", compact && "w-full")}>{actions}</div>
      )}
    </section>
  );
}

export interface CategoryHeaderProps extends Omit<ChannelHeaderProps, "avatarUrl" | "name"> {
  name: string;
  boxArtUrl?: string | null;
}

export function CategoryHeader({ boxArtUrl, ...props }: CategoryHeaderProps): React.JSX.Element {
  return <ChannelHeader {...props} avatarUrl={boxArtUrl} />;
}
