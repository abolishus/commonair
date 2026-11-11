// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's LiveStatusBar (overhaul wave 3, D5.2; creator-studio.md P2): one row on every studio
 * page saying whether the stream is offline, starting or live, and while live how long it has run,
 * how many verified viewers watch and how healthy the encoder feed is. State is never shown by
 * colour alone: the live badge, an icon plus a word for the others, and a health word beside its
 * bars. Only the state word is a live region, so the ticking uptime and the polled numbers do not
 * chatter at a screen reader.
 *
 * `compact` is the signed-in home's row (discovery): no stickiness, a card ring, smaller gaps.
 * `slot` sits before the actions, for one-off prompts (the first connection's share offer, J2-e).
 * Strings come in already translated.
 */
import type * as React from "react";
import {
  Alert02Icon,
  Loading03Icon,
  SignalFullIcon,
  SignalLowIcon,
  SignalNoIcon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { LiveBadge } from "../../primitives/live-badge.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { ViewerCount } from "../../primitives/viewer-count.tsx";
import { cn } from "../../lib/utils.ts";

export type LiveStatusState = "offline" | "starting" | "live";
/** `unknown`: live, but no health answer (yet, or the last read failed). */
export type LiveStatusHealth = "healthy" | "warning" | "unknown";

export interface LiveStatusBarLabels {
  /** The region's accessible name ("Stream status"). */
  region: string;
  offline: string;
  starting: string;
  live: string;
  /** Read before the uptime ("Live for"). */
  uptime: string;
  /** Read before the health word ("Stream health"). */
  health: string;
  healthy: string;
  warning: string;
  unknown: string;
}

export interface LiveStatusBarProps extends Omit<React.ComponentProps<"section">, "title" | "slot"> {
  state: LiveStatusState;
  labels: LiveStatusBarLabels;
  /** While live or starting: when the broadcast started (ISO 8601). */
  startedAt?: string | null;
  /** While live: verified viewers. */
  viewers?: number | null;
  /** While live: the health summary; left out (the compact home row) shows no health. */
  health?: LiveStatusHealth | null;
  /** The stream title (live), or a line such as "Last live 20 minutes ago" (offline). */
  detail?: React.ReactNode;
  /** A one-off prompt before the actions (J2-e). */
  slot?: React.ReactNode;
  /** The slot's element, for a page that portals its prompt in; hidden while empty. */
  slotRef?: React.Ref<HTMLSpanElement>;
  /** Quick links (stream manager, view channel); icon buttons below `sm`. */
  actions?: React.ReactNode;
  /** A load problem with its Retry, shown in place of nothing. */
  notice?: React.ReactNode;
  compact?: boolean;
}

const HEALTH: Record<LiveStatusHealth, { icon: IconSvgElement; tone: StatusTone }> = {
  healthy: { icon: SignalFullIcon, tone: "success" },
  warning: { icon: SignalLowIcon, tone: "warning" },
  unknown: { icon: SignalNoIcon, tone: "neutral" },
};

const STATE_BADGE: Record<Exclude<LiveStatusState, "live">, { icon: IconSvgElement; tone: StatusTone }> = {
  offline: { icon: StopCircleIcon, tone: "neutral" },
  starting: { icon: Loading03Icon, tone: "info" },
};

export function LiveStatusBar({
  state,
  labels,
  startedAt,
  viewers,
  health,
  detail,
  slot,
  slotRef,
  actions,
  notice,
  compact = false,
  className,
  ...props
}: LiveStatusBarProps): React.JSX.Element {
  const live = state === "live";
  const word = labels[state];
  return (
    <section
      aria-label={labels.region}
      data-slot="live-status-bar"
      data-state={state}
      data-compact={compact ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm",
        compact
          ? "bg-card px-4 py-3 ring-1 ring-border"
          : "sticky top-14 z-10 bg-surface-raised px-4 py-2.5 shadow-raised ring-1 ring-border sm:px-6",
        className,
      )}
      {...props}
    >
      <output className="sr-only">{word}</output>
      <span className="flex items-center gap-2" aria-hidden>
        {live ? (
          <LiveBadge label={word} />
        ) : (
          <StatusBadge tone={STATE_BADGE[state].tone} icon={STATE_BADGE[state].icon}>
            {word}
          </StatusBadge>
        )}
      </span>
      {(live || state === "starting") && startedAt ? (
        <span data-slot="live-status-uptime" className="font-medium whitespace-nowrap tabular-nums">
          <span className="sr-only">{labels.uptime} </span>
          <RelativeTime date={startedAt} mode="elapsed" tooltip={false} />
        </span>
      ) : null}
      {live && typeof viewers === "number" ? (
        <ViewerCount data-slot="live-status-viewers" count={viewers} className="text-sm font-medium text-foreground" />
      ) : null}
      {live && health ? (
        <span data-slot="live-status-health" data-health={health} className="flex items-center">
          <span className="sr-only">{labels.health} </span>
          <StatusBadge tone={HEALTH[health].tone} icon={HEALTH[health].icon}>
            {labels[health]}
          </StatusBadge>
        </span>
      ) : null}
      {detail ? (
        <span
          data-slot="live-status-detail"
          dir="auto"
          className={cn(
            "min-w-0 truncate text-muted-foreground",
            // Below sm the title takes its own row (mockups-product 8).
            compact ? "flex-1" : "order-last basis-full sm:order-none sm:flex-1 sm:basis-0",
          )}
        >
          {detail}
        </span>
      ) : (
        <span aria-hidden className="hidden flex-1 sm:block" />
      )}
      {notice ? (
        <span data-slot="live-status-notice" className="flex items-center gap-2 text-muted-foreground">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden className="size-4" />
          {notice}
        </span>
      ) : null}
      {slot || slotRef ? (
        <span ref={slotRef} data-slot="live-status-slot" className="flex min-w-0 items-center gap-2 empty:hidden">
          {slot}
        </span>
      ) : null}
      {actions ? (
        <span data-slot="live-status-actions" className="ms-auto flex items-center gap-1.5">
          {actions}
        </span>
      ) : null}
    </section>
  );
}
