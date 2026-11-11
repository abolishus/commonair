// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream manager as a control room (F21), rebalanced for live work (overhaul wave 3, D5.2;
 * creator-studio P2): on the left the live numbers and health, then "Edit stream info", then the
 * muted preview (which can be hidden); chat, the activity feed and quick actions on the right.
 * Below `lg` phone streamers live in chat, so the order is chat, stream info, preview, health,
 * then activity and quick actions (CSS `order`; the right column dissolves into the grid there).
 * The preview and chat are slots (the route passes the real `Player` and `ChatPanel`), so this
 * layout renders and tests without a media stack.
 */
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { ChartBarLineIcon, Settings02Icon, TestTube01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { cn } from "@commonair/ui/lib/utils";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { StreamHealthDto } from "../../lib/stream-health.ts";
import { StreamHealthCard } from "../stream-health-card.tsx";
import { ActivityFeed, type ActivitySource } from "./activity-feed.tsx";
import { StreamInfoEditor, type StreamInfoClient } from "./stream-info.tsx";

export interface StreamManagerProps {
  channel: string;
  /** The live broadcast's start (uptime), or null while offline. */
  startedAt: string | null;
  preview: React.ReactNode;
  chat: React.ReactNode;
  /** Fakes for tests; the real clients otherwise. */
  infoClient?: StreamInfoClient;
  healthLoad?: (channel: string) => Promise<StreamHealthDto>;
  activitySource?: ActivitySource;
  /** After stream info saves (the go-live checklist re-reads its steps). */
  onInfoSaved?: () => void;
}

export function StreamManager({
  channel,
  startedAt,
  preview,
  chat,
  infoClient,
  healthLoad,
  activitySource,
  onInfoSaved,
}: StreamManagerProps): React.JSX.Element {
  return (
    <div data-testid="stream-manager" className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
      <div className="order-2 flex min-w-0 flex-col gap-6 lg:order-none lg:col-span-2">
        <div data-slot="stream-health" className="order-3 min-w-0 lg:order-1">
          <StreamHealthCard key={channel} channel={channel} startedAt={startedAt} load={healthLoad} />
        </div>
        <div data-slot="stream-info" className="order-1 min-w-0 lg:order-2">
          <StreamInfoEditor key={`info:${channel}`} channel={channel} client={infoClient} onSaved={onInfoSaved} />
        </div>
        <PreviewSection className="order-2 lg:order-3">{preview}</PreviewSection>
      </div>
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
        <section
          data-testid="stream-chat"
          aria-label={t("studio.chatPanel.label")}
          className="order-1 min-w-0 lg:order-none"
        >
          {chat}
        </section>
        <div className="order-3 min-w-0 lg:order-none">
          <ActivityFeed key={`activity:${channel}`} channel={channel} source={activitySource} />
        </div>
        <div className="order-4 min-w-0 lg:order-none">
          <QuickActions />
        </div>
      </div>
    </div>
  );
}

/** The muted preview with "Hide preview": hiding it unmounts the player, so it stops loading video. */
function PreviewSection({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  const [shown, setShown] = React.useState(true);
  const id = React.useId();
  return (
    <section
      data-testid="stream-preview"
      data-shown={String(shown)}
      aria-label={t("studio.preview.label")}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <div className="flex justify-end">
        <Button
          data-testid="stream-preview-toggle"
          variant="ghost"
          size="sm"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? t("d5Dashboard.preview.hide") : t("d5Dashboard.preview.show")}
        </Button>
      </div>
      {/* Capped so the 16:9 preview stays under 40% of the viewport's height (D5.2). */}
      <div id={id} className="mx-auto w-full max-w-preview-cap min-w-0">
        {shown ? children : null}
      </div>
    </section>
  );
}

/** Start a poll or prediction (Polls & raids), rehearse, or open the stream's settings. */
export function QuickActions(): React.JSX.Element {
  return (
    <Card data-testid="stream-quick-actions">
      <CardHeader>
        <CardTitle>{t("studio.quick.title")}</CardTitle>
        <CardDescription>{t("studio.quick.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button
          data-testid="stream-quick-poll"
          variant="outline"
          className="justify-start"
          nativeButton={false}
          render={<Link to="/interact" />}
        >
          <HugeiconsIcon icon={ChartBarLineIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("studio.quick.poll")}
        </Button>
        <Button
          data-testid="stream-quick-rehearse"
          variant="outline"
          className="justify-start"
          nativeButton={false}
          render={<Link to="/rehearse" />}
        >
          <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("studio.quick.rehearse")}
        </Button>
        <Button
          data-testid="stream-quick-settings"
          variant="outline"
          className="justify-start"
          nativeButton={false}
          render={<Link to="/dashboard/settings" />}
        >
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("studio.quick.settings")}
        </Button>
      </CardContent>
    </Card>
  );
}
