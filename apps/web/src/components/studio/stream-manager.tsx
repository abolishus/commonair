// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream manager as a control room (F21): a `wide` grid with the muted preview, live stats and
 * health, "Edit stream info" on the left; chat, quick actions and the activity feed on the right.
 * Below `lg` it is one column in that order. The preview and chat are slots (the route passes the
 * real `Player` and `ChatPanel`), so this layout renders and tests without a media stack.
 */
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { ChartBarLineIcon, Settings02Icon, TestTube01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
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
}

export function StreamManager({
  channel,
  startedAt,
  preview,
  chat,
  infoClient,
  healthLoad,
  activitySource,
}: StreamManagerProps): React.JSX.Element {
  return (
    <div data-testid="stream-manager" className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <section data-testid="stream-preview" aria-label={t("studio.preview.label")} className="min-w-0">
          {preview}
        </section>
        <StreamHealthCard key={channel} channel={channel} startedAt={startedAt} load={healthLoad} />
        <StreamInfoEditor key={`info:${channel}`} channel={channel} client={infoClient} />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <section data-testid="stream-chat" aria-label={t("studio.chatPanel.label")} className="min-w-0">
          {chat}
        </section>
        <QuickActions />
        <ActivityFeed key={`activity:${channel}`} channel={channel} source={activitySource} />
      </div>
    </div>
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
