// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StudioShell, type NavItem } from "@commonair/ui/layouts";
import {
  Analytics01Icon,
  BotIcon,
  BubbleChatSecureIcon,
  ChartBarLineIcon,
  ClosedCaptionIcon,
  DashboardSquare01Icon,
  FileImportIcon,
  Money03Icon,
  Notification03Icon,
  PackageMovingIcon,
  ServerStack01Icon,
  Settings02Icon,
  ShieldUserIcon,
  SourceCodeIcon,
  Share08Icon,
  TestTube01Icon,
  UserGroupIcon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet, createFileRoute, useLocation, type ErrorComponentProps } from "@tanstack/react-router";
import * as React from "react";
import { ErrorState, NotFoundState, ShellFallback } from "../components/not-found.tsx";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { LiveStatusSlotProvider, StudioLiveStatusBar } from "../components/studio-shell/live-status.tsx";
import { useModerates } from "../components/studio-shell/moderates.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { studioNavGroups, type StudioEntry, type StudioGroupId } from "../lib/nav.ts";

/**
 * Creator tools in the studio sidebar, grouped (overhaul D5.8): Home, Set up, Community, Channels
 * you moderate (only for a member with a role elsewhere, J5-a), Content, Money, Grow and Co-op &
 * tools. The sticky LiveStatusBar (D5.2) heads every studio page; a page can put a one-off prompt
 * in its slot with `<LiveStatusSlot>`. Each page guards its own session.
 */
export const Route = createFileRoute("/_studio")({
  component: StudioLayout,
  errorComponent: StudioError,
  notFoundComponent: StudioNotFound,
});

/** The boundary replaced the studio layout: the public chrome, not a sidebar that may have failed. */
function StudioError({ error, reset }: ErrorComponentProps): React.JSX.Element {
  return (
    <ShellFallback wrap>
      <ErrorState error={error} reset={reset} />
    </ShellFallback>
  );
}

function StudioNotFound(): React.JSX.Element {
  const replaced = Route.useMatch({ select: (m) => m.status === "notFound" });
  return (
    <ShellFallback wrap={replaced}>
      <NotFoundState />
    </ShellFallback>
  );
}

function studioItem(entry: StudioEntry): NavItem {
  const base = { id: entry.id, current: entry.current };
  switch (entry.id) {
    case "streamManager":
      return {
        ...base,
        label: t("studio.streamManager"),
        icon: <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} aria-hidden />,
        render: <Link to="/dashboard" />,
      };
    case "streamSettings":
      return {
        ...base,
        label: t("studio.item.streamSettings"),
        icon: <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-stream-settings-link" to="/dashboard/settings" />,
      };
    case "moderated": {
      const channel = entry.params?.channel ?? "";
      const name = entry.label ?? channel;
      return {
        ...base,
        // One per channel, so the slug keeps ids (and test ids) unique on the page.
        id: `moderated-${channel}`,
        label: name,
        icon: <HugeiconsIcon icon={ShieldUserIcon} strokeWidth={2} aria-hidden />,
        render: (
          <Link
            data-testid={`studio-moderated-link-${channel}`}
            aria-label={t("d5Shell.item.moderated", { channel: name })}
            to="/mod/$channel"
            params={{ channel }}
          />
        ),
      };
    }
    case "audience":
      return {
        ...base,
        label: t("d5Shell.item.audience"),
        icon: <HugeiconsIcon icon={Share08Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-audience-link" to="/move" />,
      };
    case "modView":
      return {
        ...base,
        label: t("studio.item.modView"),
        icon: <HugeiconsIcon icon={ShieldUserIcon} strokeWidth={2} aria-hidden />,
        render: (
          <Link
            data-testid="studio-mod-view-link"
            to="/mod/$channel"
            params={{ channel: entry.params?.channel ?? "" }}
          />
        ),
      };
    case "rehearse":
      return {
        ...base,
        label: t("studio.rehearse"),
        icon: <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-rehearse-link" to="/rehearse" />,
      };
    case "overlays":
      return {
        ...base,
        label: t("studio.overlays"),
        icon: <HugeiconsIcon icon={Notification03Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-overlays-link" to="/overlays" />,
      };
    case "interact":
      return {
        ...base,
        label: t("studio.interact"),
        icon: <HugeiconsIcon icon={ChartBarLineIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-interact-link" to="/interact" />,
      };
    case "bot":
      return {
        ...base,
        label: t("studio.bot"),
        icon: <HugeiconsIcon icon={BotIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-bot-link" to="/bot" />,
      };
    case "chat":
      return {
        ...base,
        label: t("studio.chat"),
        icon: <HugeiconsIcon icon={BubbleChatSecureIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-chat-link" to="/chat" />,
      };
    case "captions":
      return {
        ...base,
        label: t("studio.captions"),
        icon: <HugeiconsIcon icon={ClosedCaptionIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-captions-link" to="/captions" />,
      };
    case "content":
      return {
        ...base,
        label: t("studio.content"),
        icon: <HugeiconsIcon icon={Video01Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-content-link" to="/content" />,
      };
    case "analytics":
      return {
        ...base,
        label: t("studio.analytics"),
        icon: <HugeiconsIcon icon={Analytics01Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-analytics-link" to="/analytics" />,
      };
    case "revenue":
      return {
        ...base,
        label: t("studio.revenue"),
        icon: <HugeiconsIcon icon={Money03Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="revenue-link" to="/revenue" />,
      };
    case "crew":
      return {
        ...base,
        label: t("studio.crew"),
        icon: <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-crew-link" to="/crew" />,
      };
    case "relays":
      return {
        ...base,
        label: t("studio.relays"),
        icon: <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="relays-link" to="/relays" />,
      };
    case "move":
      return {
        ...base,
        label: t("studio.move"),
        icon: <HugeiconsIcon icon={PackageMovingIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-move-link" to="/move" />,
      };
    case "import":
      return {
        ...base,
        label: t("studio.import"),
        icon: <HugeiconsIcon icon={FileImportIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-import-link" to="/import" />,
      };
    case "developer":
      return {
        ...base,
        label: t("studio.developer"),
        icon: <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-developer-link" to="/developer" />,
      };
  }
}

const GROUP_LABEL: Record<StudioGroupId, MessageKey> = {
  home: "d5Shell.group.home",
  setup: "d5Shell.group.setup",
  community: "studio.group.community",
  moderates: "d5Shell.group.moderates",
  content: "studio.group.content",
  money: "studio.group.money",
  grow: "d5Shell.group.grow",
  coopTools: "d5Shell.group.coopTools",
};

function StudioLayout(): React.JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { instance, me } = useBootstrap();
  const channel = me ? (me.channelSlug ?? me.username) : "";
  const moderates = useModerates(me?.id ?? null);
  const [slotHost, setSlotHost] = React.useState<HTMLSpanElement | null>(null);
  const groups = studioNavGroups(pathname, {
    chatSafety: instance.chatSafety,
    twitchImport: instance.twitchImport,
    channel,
    moderates: moderates.map((m) => ({ slug: m.channel.slug, displayName: m.channel.displayName })),
  })
    // Signed out, the page redirects; the mod view has no channel to open until then.
    .map((group) => ({ ...group, items: channel ? group.items : group.items.filter((i) => i.id !== "modView") }))
    .map((group) => ({ id: group.id, label: t(GROUP_LABEL[group.id]), items: group.items.map(studioItem) }));
  return (
    <StudioShell
      header={<AppHeader studio />}
      groups={groups}
      sidebarLabel={t("studio.nav")}
      skipLabel={t("nav.skipToContent")}
      footer={<AppFooter />}
      statusBar={<StudioLiveStatusBar slug={channel || null} pathname={pathname} slotRef={setSlotHost} />}
    >
      <LiveStatusSlotProvider host={slotHost}>
        <Outlet />
      </LiveStatusSlotProvider>
    </StudioShell>
  );
}
