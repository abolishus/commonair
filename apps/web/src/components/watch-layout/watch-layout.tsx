// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live channel page's layout pieces (overhaul D4.1, D4.6, D4.7; mockup
 * product/channel-live-mobile.html):
 *
 * - `WatchPanelSwitch` (`watch-panel-switch`): "Chat | About" under the compact row, below `lg`
 *   only. Chat is the default while live, About offline (`defaultWatchPanel`). The page hides the
 *   other panel with CSS, so chat keeps its connection, scroll and draft.
 * - `OwnerShortcuts` (`channel-owner-stream-manager`, `channel-owner-edit`): on their own channel.
 * - `ModViewButton` (`channel-mod-view`) and `useModerates`: for a moderator or editor who does not
 *   own it (both may open the mod view).
 * - `TrustBadge`: the owner's co-op standing, one neutral mark (council outranks member-owner).
 * - `VerifiedViewers`: "Verified viewers" beside the live count. The "How we count" link waits for
 *   a page that explains verified-viewer counting (none exists yet).
 *
 * The phone layout itself is CSS (`watch-layout.css`, keyed on `data-watch-*`), so the server
 * render is already right on a phone and nothing remounts when the viewport crosses `lg`.
 */
import type { ModeratedChannel } from "@commonair/contracts/dto";
import { StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { cn } from "@commonair/ui/lib/utils";
import {
  DashboardSpeed01Icon,
  JusticeScale01Icon,
  PencilEdit02Icon,
  ShieldUserIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import "./watch-layout.css";

export const WATCH_PANELS = ["chat", "about"] as const;
export type WatchPanel = (typeof WATCH_PANELS)[number];

const isWatchPanel = (v: unknown): v is WatchPanel => v === "chat" || v === "about";

/**
 * Chat while live on Home; About offline, or when the URL already asks for another channel tab
 * (Videos, Clips, About live in the About panel).
 */
export function defaultWatchPanel(live: boolean, tab: string): WatchPanel {
  return live && tab === "home" ? "chat" : "about";
}

/** The panel the phone layout shows; back to the default when the channel goes live or offline. */
export function useWatchPanel(live: boolean, tab: string): [WatchPanel, (next: WatchPanel) => void] {
  const [state, setState] = React.useState(() => ({ live, panel: defaultWatchPanel(live, tab) }));
  let current = state;
  if (state.live !== live) {
    current = { live, panel: defaultWatchPanel(live, tab) };
    setState(current);
  }
  const set = React.useCallback((panel: WatchPanel) => setState((s) => ({ ...s, panel })), []);
  return [current.panel, set];
}

export function WatchPanelSwitch({
  value,
  onChange,
  className,
}: {
  value: WatchPanel;
  onChange: (next: WatchPanel) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <Tabs
      data-testid="watch-panel-switch"
      data-panel={value}
      value={value}
      onValueChange={(next: unknown) => {
        if (isWatchPanel(next) && next !== value) onChange(next);
      }}
      className={cn("px-4 py-2 lg:hidden", className)}
    >
      <TabsList aria-label={t("d4Layout.panels.label")} className="grid w-full grid-cols-2 bg-muted">
        <TabsTrigger value="chat" data-testid="watch-panel-chat" className="min-h-9 text-sm">
          {t("d4Layout.panels.chat")}
        </TabsTrigger>
        <TabsTrigger value="about" data-testid="watch-panel-about" className="min-h-9 text-sm">
          {t("d4Layout.panels.about")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** The owner's way from their channel page to the stream manager and the channel settings. */
export function OwnerShortcuts(): React.JSX.Element {
  return (
    <>
      <Button
        data-testid="channel-owner-stream-manager"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<Link to="/dashboard" />}
      >
        <HugeiconsIcon icon={DashboardSpeed01Icon} strokeWidth={2} aria-hidden />
        {t("channel.tabs.streamManager")}
      </Button>
      <Button
        data-testid="channel-owner-edit"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<Link to="/dashboard/settings" />}
      >
        <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} aria-hidden />
        {t("d4Layout.owner.editChannel")}
      </Button>
    </>
  );
}

export function ModViewButton({ channel }: { channel: string }): React.JSX.Element {
  return (
    <Button
      data-testid="channel-mod-view"
      variant="outline"
      size="sm"
      nativeButton={false}
      render={<Link to="/mod/$channel" params={{ channel }} />}
    >
      <HugeiconsIcon icon={ShieldUserIcon} strokeWidth={2} aria-hidden />
      {t("d4Layout.mod.view")}
    </Button>
  );
}

export interface ModeratesClient {
  moderates(): Promise<readonly ModeratedChannel[]>;
}

const apiModerates: ModeratesClient = { moderates: () => api().me.moderates() };

/**
 * Whether the signed-in viewer moderates `channel` (`me.moderates`, which never lists their own).
 * Any row counts: an editor may moderate too (`access.ts`, chat).
 * Asked only when `enabled` (signed in, not the owner); any failure reads as "no".
 */
export function useModerates(channel: string, enabled: boolean, client: ModeratesClient = apiModerates): boolean {
  const [answer, setAnswer] = React.useState<{ channel: string; moderates: boolean } | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let current = true;
    client.moderates().then(
      (list) => {
        if (current) setAnswer({ channel, moderates: list.some((m) => m.channel.slug === channel) });
      },
      () => {
        if (current) setAnswer({ channel, moderates: false });
      },
    );
    return () => {
      current = false;
    };
  }, [channel, enabled, client]);
  return enabled && answer?.channel === channel && answer.moderates;
}

export interface OwnerCoop {
  member: boolean;
  council: boolean;
}

/**
 * One neutral mark (never brand-filled): Creator council outranks Member-owner; none otherwise.
 * The long form is screen-reader text inside the badge: `aria-label` on its plain span (no role)
 * is not a valid name, and readers may skip it.
 */
export function TrustBadge({
  coop,
  name,
  className,
  ...props
}: {
  coop: OwnerCoop | null | undefined;
  name: string;
  className?: string;
} & { [key: `data-${string}`]: string | undefined }): React.JSX.Element | null {
  if (!coop || (!coop.council && !coop.member)) return null;
  const council = coop.council;
  return (
    <StatusBadge
      tone="neutral"
      icon={council ? JusticeScale01Icon : UserGroupIcon}
      data-kind={council ? "council" : "member"}
      className={cn("shrink-0", className)}
      {...props}
    >
      <span data-slot="trust-short" aria-hidden>
        {council ? t("d4Layout.trust.council") : t("d4Layout.trust.member")}
      </span>
      <span data-slot="trust-long" className="sr-only">
        {council ? t("d4Layout.trust.councilLabel", { name }) : t("d4Layout.trust.memberLabel", { name })}
      </span>
    </StatusBadge>
  );
}

/** "Verified viewers", beside the live count. */
export function VerifiedViewers({
  className,
  ...props
}: { className?: string } & { [key: `data-${string}`]: string | undefined }): React.JSX.Element {
  return (
    <span className={cn("inline-flex min-w-0 items-center", className)} {...props}>
      {t("d4Layout.viewers.verified")}
    </span>
  );
}
