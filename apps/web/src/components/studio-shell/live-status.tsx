// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's sticky LiveStatusBar (overhaul wave 3, D5.2) wired to the member's own channel,
 * the compact row the signed-in home shows while they are live, and the slot a studio page can
 * put a one-off prompt in (`<LiveStatusSlot>`, the first connection's share offer, J2-e).
 */
import type { StreamCard } from "@commonair/contracts/dto";
import { RelativeTime } from "@commonair/ui";
import { LiveStatusBar, type LiveStatusBarLabels } from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { DashboardSquare01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.ts";
import { healthSummary, liveStatusState, verifiedViewers } from "./model.ts";
import { useLiveStatus, type LiveStatusLoader, type StatusPollEnv } from "./use-live-status.ts";

export function liveStatusLabels(): LiveStatusBarLabels {
  return {
    region: t("d5Shell.status.region"),
    offline: t("d5Shell.status.offline"),
    starting: t("d5Shell.status.starting"),
    live: t("d5Shell.status.live"),
    uptime: t("d5Shell.status.uptime"),
    health: t("d5Shell.status.health"),
    healthy: t("d5Shell.status.healthy"),
    warning: t("d5Shell.status.warning"),
    unknown: t("d5Shell.status.unknown"),
  };
}

const SlotContext = React.createContext<HTMLElement | null>(null);

/**
 * Renders `children` into the studio LiveStatusBar's slot, beside its quick links. Outside the
 * studio layout (or before the bar mounts) it renders nothing.
 */
export function LiveStatusSlot({ children }: { children: React.ReactNode }): React.ReactNode {
  const host = React.useContext(SlotContext);
  return host ? createPortal(children, host) : null;
}

/** Provides the slot to the studio pages below; the layout wraps its outlet in it. */
export function LiveStatusSlotProvider({
  host,
  children,
}: {
  host: HTMLElement | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return <SlotContext.Provider value={host}>{children}</SlotContext.Provider>;
}

const icon = (glyph: typeof DashboardSquare01Icon) => (
  <HugeiconsIcon icon={glyph} strokeWidth={2} aria-hidden data-icon="inline-start" />
);

export interface StudioLiveStatusBarProps {
  /** The member's own channel; null renders nothing (signed out: the page redirects). */
  slug: string | null;
  /** The pathname, so the stream manager link is marked current on `/dashboard`. */
  pathname: string;
  /** Where `<LiveStatusSlot>` content lands. */
  slotRef?: React.Ref<HTMLSpanElement>;
  loader?: LiveStatusLoader;
  env?: StatusPollEnv;
}

export function StudioLiveStatusBar({
  slug,
  pathname,
  slotRef,
  loader,
  env,
}: StudioLiveStatusBarProps): React.ReactNode {
  const status = useLiveStatus(slug, loader, env);
  if (slug === null) return null;
  const { channel, health } = status;
  const state = liveStatusState(channel, health);
  const onManager = pathname.replace(/\/+$/, "") === "/dashboard";
  const lastLiveAt = channel?.lastLiveAt ?? null;
  const detail =
    state !== "offline" ? (
      channel?.live?.title || undefined
    ) : channel === null ? undefined : lastLiveAt ? (
      <>
        {t("d5Shell.status.lastLive")} <RelativeTime date={lastLiveAt} />
      </>
    ) : (
      t("d5Shell.status.neverLive")
    );
  return (
    <LiveStatusBar
      data-testid="studio-status-bar"
      state={state}
      labels={liveStatusLabels()}
      startedAt={channel?.live?.startedAt ?? null}
      viewers={verifiedViewers(channel, health)}
      health={healthSummary(health)}
      detail={detail}
      slotRef={slotRef}
      notice={
        status.failed ? (
          <>
            <span data-testid="studio-status-error">{t("d5Shell.status.loadFailed")}</span>
            <Button data-testid="studio-status-retry" variant="outline" size="sm" onClick={status.retry}>
              {t("d5Shell.status.retry")}
            </Button>
          </>
        ) : undefined
      }
      actions={
        <>
          <Button
            data-testid="studio-status-manager"
            variant="ghost"
            size="sm"
            nativeButton={false}
            aria-current={onManager ? "page" : undefined}
            render={<Link to="/dashboard" />}
          >
            {icon(DashboardSquare01Icon)}
            {t("d5Shell.status.manager")}
          </Button>
          <Button
            data-testid="studio-status-channel"
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/$channel" params={{ channel: slug }} />}
          >
            {icon(LinkSquare02Icon)}
            {t("d5Shell.status.viewChannel")}
          </Button>
        </>
      }
    />
  );
}

/**
 * The signed-in home's row while the member is live (discovery's `LiveStatusBar compact`, F7):
 * from the home feed's own card, so it reads nothing itself.
 */
export function CompactLiveStatusBar({
  card,
  region,
  title,
  manager,
  ...props
}: {
  card: StreamCard;
  /** The row's accessible name and its strings (the caller's catalog). */
  region: string;
  title: string;
  manager: string;
} & Omit<React.ComponentProps<"section">, "title">): React.JSX.Element {
  const { broadcast } = card;
  return (
    <LiveStatusBar
      compact
      state="live"
      labels={{ ...liveStatusLabels(), region }}
      startedAt={broadcast.startedAt}
      viewers={broadcast.viewerCount}
      detail={
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-foreground">{title}</span>
          <span className="min-w-0 truncate">{broadcast.title}</span>
        </span>
      }
      actions={
        <Button
          data-testid="home-own-live-manager"
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/dashboard" />}
        >
          {manager}
        </Button>
      }
      {...props}
    />
  );
}
