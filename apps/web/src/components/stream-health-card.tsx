// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonText, StatusBadge } from "@commonair/ui";
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
import { FormError } from "./form-error.tsx";

/**
 * Warnings of the latest health sample, polled while the dashboard tab is visible. Render it with
 * `key={channel}` so switching channels starts from the loading state.
 */
export function StreamHealthCard({ channel }: { channel: string }): React.JSX.Element {
  const [health, setHealth] = React.useState<StreamHealthDto | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      // A slow response must not pile requests up behind it.
      if (inFlight) return;
      inFlight = true;
      api()
        .stream.health({ channel })
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
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
  }, [channel]);

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
        {failed && <FormError>{t("dashboard.health.loadFailed")}</FormError>}
        {!health && !failed && <SkeletonText lines={2} />}
        {state === "offline" && (
          <EmptyState
            icon={Tv01Icon}
            title={t("dashboard.health.offline")}
            description={t("dashboard.health.offlineHint")}
            headingLevel={3}
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
