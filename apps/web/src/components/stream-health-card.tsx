// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonText, StatusBadge, ViewerCount, formatNumber, formatUnit, useLocale } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { CheckmarkCircle02Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import {
  browserPollEnv,
  HEALTH_POLL_MS,
  healthState,
  latestWarnings,
  pollWhileVisible,
  warningMessage,
  healthBadge,
  type StreamHealthDto,
} from "../lib/stream-health.ts";
import { SectionLoadError } from "../lib/section-load-error.tsx";
import { formatUptime, uptimeSeconds } from "./channel/channel-data.ts";
import { StudioLinkAction } from "./studio/empty-action.tsx";

type Sample = StreamHealthDto["samples"][number];

/** The newest sample while live (the API sorts oldest first, but this does not rely on it). */
export function latestSample(health: Pick<StreamHealthDto, "live" | "samples">): Sample | null {
  if (!health.live) return null;
  let latest: Sample | null = null;
  for (const s of health.samples) if (!latest || Date.parse(s.at) >= Date.parse(latest.at)) latest = s;
  return latest;
}

/**
 * The live numbers (F21): watching now (the public live count, overhaul decision 2), the running
 * peak, DVR viewers catching up, uptime and the newest sample's bitrate, frame rate, dropped frames
 * and resolution. A figure the API or the sample does not carry is left out, never guessed.
 */
export function LiveNumbers({
  health,
  startedAt,
  now,
}: {
  health: StreamHealthDto;
  startedAt: string | null;
  now: number;
}): React.JSX.Element {
  const { locale } = useLocale();
  const s = latestSample(health);
  const rows: { term: string; value: React.ReactNode; id: string; raw: string | number }[] = [
    {
      id: "viewers",
      term: t("fixViewers.health.watchingNow"),
      value: <ViewerCount count={health.viewers.verified} />,
      raw: health.viewers.verified,
    },
  ];
  if (health.peakSoFar !== undefined) {
    // Never below the count beside it, whichever was read first.
    const peak = Math.max(health.peakSoFar, health.viewers.verified);
    rows.push({
      id: "peak",
      term: t("fixViewers.health.peakSoFar"),
      value: <ViewerCount count={peak} icon={false} />,
      raw: peak,
    });
  }
  const catchingUp = health.viewers.catchingUp ?? 0;
  if (catchingUp > 0)
    rows.push({
      id: "catchingUp",
      term: t("fixViewers.health.catchingUp"),
      value: formatNumber(catchingUp, locale),
      raw: catchingUp,
    });
  if (startedAt) {
    const secs = uptimeSeconds(startedAt, now);
    rows.push({ id: "uptime", term: t("studio.health.uptime"), value: formatUptime(secs), raw: secs });
  }
  if (s) {
    rows.push({
      id: "bitrate",
      term: t("studio.health.bitrate"),
      value: formatUnit(s.bitrateKbps, "kilobit-per-second", locale, { maximumFractionDigits: 0 }),
      raw: s.bitrateKbps,
    });
    if (s.fps !== null)
      rows.push({
        id: "fps",
        term: t("studio.health.fps"),
        value: formatNumber(Math.round(s.fps * 10) / 10, locale),
        raw: s.fps,
      });
    rows.push({
      id: "dropped",
      term: t("studio.health.dropped"),
      value: formatNumber(s.droppedFrames, locale),
      raw: s.droppedFrames,
    });
    if (s.width !== null && s.height !== null)
      rows.push({
        id: "resolution",
        term: t("studio.health.resolution"),
        value: t("studio.health.resolutionValue", { width: String(s.width), height: String(s.height) }),
        raw: `${s.width}x${s.height}`,
      });
  }
  return (
    <div className="flex flex-col gap-2">
      <dl data-testid="stream-health-numbers" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.id} data-testid="stream-health-number" data-metric={r.id} data-value={r.raw} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{r.term}</dt>
            <dd className="text-sm font-medium tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p data-testid="stream-health-viewers-hint" className="text-xs text-muted-foreground">
        {t("fixViewers.health.hint")}
      </p>
    </div>
  );
}

/**
 * Live stats and health: the numbers above and the latest sample's warnings, polled while the
 * dashboard tab is visible. Render it with `key={channel}` so switching channels starts from the
 * loading state. `startedAt` (the live broadcast's) adds the uptime.
 */
export function StreamHealthCard({
  channel,
  startedAt = null,
  load,
}: {
  channel: string;
  startedAt?: string | null;
  /** `stream.health`; tests pass a fake. */
  load?: (channel: string) => Promise<StreamHealthDto>;
}): React.JSX.Element {
  const [now, setNow] = React.useState(() => Date.now());
  const [health, setHealth] = React.useState<StreamHealthDto | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Retry restarts the poll, which asks again at once.
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      // A slow response must not pile requests up behind it.
      if (inFlight) return;
      inFlight = true;
      (load ?? ((c: string) => api().stream.health({ channel: c })))(channel)
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
          setNow(Date.now());
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const stop = pollWhileVisible(tick, HEALTH_POLL_MS, browserPollEnv());
    return () => {
      cancelled = true;
      stop();
    };
    // `attempt` only restarts the poll (Retry).
  }, [channel, load, attempt]);

  const state = health ? healthState(health) : undefined;
  const warnings = health ? latestWarnings(health) : [];

  const badge = state ? healthBadge(state) : undefined;

  return (
    <Card data-testid="stream-health" data-state={state} aria-busy={!health && !failed}>
      <CardHeader>
        <CardTitle>{t("dashboard.health.title")}</CardTitle>
        <CardDescription>{t("dashboard.health.hint")}</CardDescription>
        {badge && (
          <CardAction>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failed && (
          <SectionLoadError
            section={t("dashboard.health.title")}
            load={{ reload: () => setAttempt((n) => n + 1) }}
            headingLevel={3}
            data-testid="stream-health-error"
            retryTestId="stream-health-retry"
          />
        )}
        {!health && !failed && <SkeletonText lines={2} />}
        {health && state !== "offline" && <LiveNumbers health={health} startedAt={startedAt} now={now} />}
        {state === "offline" && (
          <EmptyState
            icon={Tv01Icon}
            title={t("dashboard.health.offline")}
            description={t("dashboard.health.offlineHint")}
            headingLevel={3}
            action={<StudioLinkAction to="/dashboard/settings">{t("studio.empty.setUpStream")}</StudioLinkAction>}
          />
        )}
        {state === "healthy" && (
          <EmptyState
            icon={CheckmarkCircle02Icon}
            title={t("dashboard.health.healthy")}
            description={t("dashboard.health.healthyHint")}
            headingLevel={3}
          />
        )}
        {state === "warning" && (
          <KeyValueList
            aria-label={t("dashboard.health.warnings")}
            aria-live="polite"
            rows={warnings.map((code) => {
              const msg = warningMessage(code);
              return {
                // The fix hint is the useful part, so it sits under the title rather than in a tooltip.
                term: (
                  <span data-testid="stream-health-warning" data-code={code} className="flex flex-col gap-0.5">
                    <span>{msg.title}</span>
                    <span>{msg.hint}</span>
                  </span>
                ),
                value: <StatusBadge tone="warning">{t("dashboard.health.warningBadge")}</StatusBadge>,
              };
            })}
          />
        )}
      </CardContent>
    </Card>
  );
}
