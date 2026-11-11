// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream recap at the top of `/dashboard` after a broadcast (overhaul wave 3, D5.3;
 * creator-studio P3, voice-copy 4.9), until it is dismissed or the next stream starts. Viewer
 * numbers appear only once the analytics settle them (24 h after the end); until then the card
 * says so and shows what is already true: how long it ran, the running peak marked provisional, the
 * exact follows, clips and chat messages (`stream.lastBroadcast`), and the video. Factual, never hype. It
 * also carries the one-time "You're a member-owner now" notice when the owner is a co-op member.
 */
import {
  IconButton,
  MoneyAmount,
  RelativeTime,
  SkeletonText,
  ViewerCount,
  formatDuration,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { toast } from "@commonair/ui/toast";
import type { AnalyticsRange, LastBroadcast } from "@commonair/contracts/dto";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { watchUrl } from "../watch/share.ts";
import {
  RANGE_BEFORE_MS,
  RECAP_DISMISSED_KEY,
  averageViewers,
  lastBroadcastWindow,
  matchLastBroadcast,
  memberNoticeKey,
  pickRecapVideo,
  readFlag,
  recapVisible,
  recapWindow,
  settledBroadcast,
  writeFlag,
} from "./model.ts";

/** Integer cents with their currency (the contract's `Money`). */
export interface Money {
  cents: number;
  currency: string;
}

export interface RecapVideo {
  id: string;
  status: "recording" | "processing" | "ready" | "failed" | "deleted";
  createdAt: string;
}

export interface RecapClient {
  range: (channel: string, from: string, to: string) => Promise<AnalyticsRange>;
  vods: (channel: string) => Promise<RecapVideo[]>;
  /** `stream.lastBroadcast`: the exact follows, clips and chat of the last stream. */
  lastBroadcast: (channel: string) => Promise<LastBroadcast | null>;
  revenue: (channel: string, from: string, to: string) => Promise<{ net: Money; gross: Money }>;
}

export const apiRecapClient: RecapClient = {
  range: (channel, from, to) => api().analytics.range({ channel, from, to }),
  vods: async (channel) => (await api().vods.list({ channel, limit: 10 })).items,
  lastBroadcast: (channel) => api().stream.lastBroadcast({ channel }),
  revenue: (channel, from, to) => api().money.revenue({ channel, from, to }),
};

export interface StreamRecapProps {
  channel: string;
  publicUrl: string;
  /** The channel is live now (the recap waits for the next stream to end). */
  live: boolean;
  /** `Channel.lastLiveAt`. */
  lastLiveAt: string | null;
  vodEnabled: boolean;
  /** `Channel.ownerCoop.member`: shows the one-time member-owner notice. */
  member: boolean;
  client?: RecapClient;
  /** For tests. */
  now?: () => number;
}

interface RecapData {
  settled: AnalyticsRange["broadcasts"][number] | null;
  /** The stream's exact counts; null when the server has none for this stream. */
  last: LastBroadcast | null;
  video: RecapVideo | null;
  net: Money | null;
}

export function StreamRecap({
  channel,
  publicUrl,
  live,
  lastLiveAt,
  vodEnabled,
  member,
  client = apiRecapClient,
  now = Date.now,
}: StreamRecapProps): React.JSX.Element | null {
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(() => readFlag(RECAP_DISMISSED_KEY));
  const [memberSeen, setMemberSeen] = React.useState(() => readFlag(memberNoticeKey(channel)) !== null);
  const visible = recapVisible({ live, lastLiveAt, dismissedFor }, now());
  if (!visible || !lastLiveAt) return null;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="stream-recap-area">
      <RecapCard
        key={lastLiveAt}
        channel={channel}
        publicUrl={publicUrl}
        lastLiveAt={lastLiveAt}
        vodEnabled={vodEnabled}
        client={client}
        now={now}
        onDismiss={() => {
          trackUi("studio.recap", "dismiss");
          writeFlag(RECAP_DISMISSED_KEY, lastLiveAt);
          setDismissedFor(lastLiveAt);
        }}
      />
      {member && !memberSeen ? (
        <MemberNotice
          onSeen={() => {
            writeFlag(memberNoticeKey(channel), "1");
            setMemberSeen(true);
          }}
        />
      ) : null}
      <AlertCallout
        data-testid="stream-recap-come-back"
        tone="neutral"
        title={t("d5Dashboard.recap.comeBack.title")}
        description={t("d5Dashboard.recap.comeBack.body")}
        action={
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/dashboard/settings" onClick={() => trackUi("studio.recap", "click", "continue")} />}
          >
            {t("d5Dashboard.recap.comeBack.action")}
          </Button>
        }
      />
    </div>
  );
}

function RecapCard({
  channel,
  publicUrl,
  lastLiveAt,
  vodEnabled,
  client,
  now,
  onDismiss,
}: {
  channel: string;
  publicUrl: string;
  lastLiveAt: string;
  vodEnabled: boolean;
  client: RecapClient;
  now: () => number;
  onDismiss: () => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  const load = useRetryingLoad(`recap|${channel}|${lastLiveAt}`, async (): Promise<RecapData> => {
    const end = Date.parse(lastLiveAt);
    const [range, vods, lastRow] = await Promise.all([
      client.range(channel, new Date(end - RANGE_BEFORE_MS).toISOString(), new Date(now()).toISOString()),
      client.vods(channel),
      // The counts are extra: without them the card still states what it knows.
      client.lastBroadcast(channel).catch(() => null),
    ]);
    const settled = settledBroadcast(range.broadcasts, lastLiveAt);
    const last = matchLastBroadcast(lastRow, lastLiveAt);
    const window = last ? lastBroadcastWindow(last) : recapWindow(lastLiveAt, settled);
    const video = pickRecapVideo(vods, last, window);
    // Earnings wait for the settled numbers, as before: one request fewer while they settle.
    if (!settled) return { settled, last, video, net: null };
    const net = await client
      .revenue(channel, new Date(window.start).toISOString(), new Date(window.end).toISOString())
      .then(
        (r) => (r.gross.cents > 0 ? r.net : null),
        () => null,
      );
    return { settled, last, video, net };
  });
  React.useEffect(() => {
    if (load.data) trackUi("studio.recap", "view", load.data.settled ? "live" : "none");
  }, [load.data]);

  const ended = <RelativeTime date={lastLiveAt} />;
  const data = load.data;
  const titled = data ? (data.settled ?? data.last) : null;
  return (
    <Card data-testid="stream-recap" data-settled={data ? String(data.settled !== null) : undefined}>
      <CardHeader>
        <CardTitle>
          <h2 className="font-display text-lg font-semibold">{t("d5Dashboard.recap.title")}</h2>
        </CardTitle>
        <CardDescription>
          {titled ? `${titled.title || t("d5Dashboard.recap.untitled")} · ` : null}
          {fillNode(t("d5Dashboard.recap.ended"), "time", ended)}
        </CardDescription>
        <CardAction>
          <IconButton
            data-testid="stream-recap-dismiss"
            label={t("d5Dashboard.recap.dismiss")}
            icon={Cancel01Icon}
            variant="ghost"
            onClick={onDismiss}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data ? (
          load.state === "failed" ? (
            <SectionLoadError
              section={t("d5Dashboard.recap.section")}
              load={load}
              headingLevel={3}
              data-testid="stream-recap-error"
              retryTestId="stream-recap-retry"
            />
          ) : (
            <div aria-busy="true" aria-label={t("d5Dashboard.recap.loading")}>
              <SkeletonText lines={3} />
            </div>
          )
        ) : (
          <>
            {data.settled || data.last ? <RecapStats data={data} locale={locale} /> : null}
            <p data-testid="stream-recap-note" className="text-sm text-muted-foreground">
              {data.settled ? t("d5Dashboard.recap.settled") : t("d5Dashboard.recap.settling")}{" "}
              <Link
                to="/analytics"
                className="underline underline-offset-4"
                onClick={() => trackUi("studio.recap", "click", "recent")}
              >
                {t("d5Dashboard.recap.analytics")}
              </Link>
            </p>
            <RecapVideoRow channel={channel} publicUrl={publicUrl} video={data.video} vodEnabled={vodEnabled} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RecapStats({ data, locale }: { data: RecapData; locale: string }): React.JSX.Element {
  const { settled, last, net } = data;
  const duration = settled?.durationSeconds ?? last?.durationSeconds ?? 0;
  return (
    <dl data-testid="stream-recap-stats" className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 xl:grid-cols-4">
      <Stat id="duration" label={t("d5Dashboard.recap.stat.duration")}>
        {formatDuration(duration)}
      </Stat>
      {settled ? (
        <>
          <Stat id="peak" label={t("d5Dashboard.recap.stat.peak")}>
            <ViewerCount count={settled.totals.peakVerifiedConcurrent} icon={false} />
          </Stat>
          <Stat id="average" label={t("d5Dashboard.recap.stat.average")}>
            <ViewerCount count={averageViewers(settled)} icon={false} />
          </Stat>
        </>
      ) : last ? (
        // Before the analytics settle: the running peak only, never an estimate (viewer-count.md).
        <Stat id="peak" label={t("w5Studio.recap.stat.peakSoFar")}>
          {fillNode(t("w5Studio.recap.provisional"), "count", <ViewerCount count={last.peakSoFar} icon={false} />)}
        </Stat>
      ) : null}
      {last ? (
        <Stat id="followers" label={t("d5Dashboard.recap.stat.followers")}>
          {formatNumber(last.newFollowers, locale)}
        </Stat>
      ) : null}
      {net ? (
        <Stat id="support" label={t("d5Dashboard.recap.stat.support")}>
          <MoneyAmount value={{ cents: net.cents, currency: net.currency }} />
        </Stat>
      ) : null}
      {last ? (
        <>
          <Stat id="clips" label={t("d5Dashboard.recap.stat.clips")}>
            {formatNumber(last.clips, locale)}
          </Stat>
          <Stat id="chat" label={t("w5Studio.recap.stat.chat")}>
            {formatNumber(last.chatMessages, locale)}
          </Stat>
        </>
      ) : null}
    </dl>
  );
}

function Stat({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    // The term comes first for screen readers; the number shows above it.
    <div data-stat={id} className="flex min-w-0 flex-col-reverse justify-end gap-1 bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function RecapVideoRow({
  channel,
  publicUrl,
  video,
  vodEnabled,
}: {
  channel: string;
  publicUrl: string;
  video: RecapVideo | null;
  vodEnabled: boolean;
}): React.JSX.Element {
  if (!video || video.status === "deleted") {
    return (
      <div data-testid="stream-recap-video" data-video="off" className="flex flex-wrap items-center gap-2">
        <p className="text-sm">{vodEnabled ? t("d5Dashboard.recap.video.failed") : t("d5Dashboard.recap.video.off")}</p>
        {vodEnabled ? null : (
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/dashboard/settings" />}>
            {t("d5Dashboard.recap.video.turnOn")}
          </Button>
        )}
      </div>
    );
  }
  if (video.status === "failed")
    return (
      <p data-testid="stream-recap-video" data-video="failed" className="text-sm">
        {t("d5Dashboard.recap.video.failed")}
      </p>
    );
  if (video.status !== "ready")
    return (
      <p data-testid="stream-recap-video" data-video="processing" className="text-sm">
        {t("d5Dashboard.recap.video.processing")}
      </p>
    );
  const share = async () => {
    trackUi("studio.recap", "click", "videos");
    try {
      await navigator.clipboard.writeText(watchUrl(publicUrl, "vod", channel, video.id));
      toast.success(t("d5Dashboard.recap.shareCopied"));
    } catch {
      toast.error(t("d5Dashboard.recap.shareFailed"));
    }
  };
  return (
    <div data-testid="stream-recap-video" data-video="ready" className="flex flex-wrap items-center gap-2">
      <p className="me-auto text-sm">{t("d5Dashboard.recap.video.ready")}</p>
      <Button data-testid="stream-recap-share" variant="outline" size="sm" onClick={() => void share()}>
        {t("d5Dashboard.recap.share")}
      </Button>
      <Button
        data-testid="stream-recap-clip"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={
          <Link
            to="/$channel/vods/$vodId"
            params={{ channel, vodId: video.id }}
            onClick={() => trackUi("studio.recap", "click", "clips")}
          />
        }
      >
        {t("d5Dashboard.recap.clip")}
      </Button>
    </div>
  );
}

function MemberNotice({ onSeen }: { onSeen: () => void }): React.JSX.Element {
  React.useEffect(() => {
    trackUi("studio.recap", "view", "join");
  }, []);
  return (
    <AlertCallout
      data-testid="stream-recap-member"
      tone="info"
      title={t("d5Dashboard.member.title")}
      description={t("d5Dashboard.member.body")}
      action={
        <span className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={
              <Link
                to="/coop/proposals"
                onClick={() => {
                  trackUi("studio.recap", "click", "vote");
                  onSeen();
                }}
              />
            }
          >
            {t("d5Dashboard.member.action")}
          </Button>
          <Button data-testid="stream-recap-member-dismiss" variant="ghost" size="sm" onClick={onSeen}>
            {t("d5Dashboard.member.dismiss")}
          </Button>
        </span>
      }
    />
  );
}
