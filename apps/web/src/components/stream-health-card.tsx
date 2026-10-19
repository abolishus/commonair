// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonText } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Alert02Icon, CheckmarkCircle02Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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

  return (
    <Card data-testid="stream-health" data-state={state} aria-busy={!health && !failed}>
      <CardHeader>
        <CardTitle>{t("dashboard.health.title")}</CardTitle>
        <CardDescription>{t("dashboard.health.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-xs">
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
          <ul className="flex flex-col gap-3" aria-label={t("dashboard.health.warnings")} aria-live="polite">
            {warnings.map((code) => {
              const msg = warningMessage(code);
              return (
                <li key={code} data-testid="stream-health-warning" data-code={code} className="flex gap-2">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-foreground">{msg.title}</span>
                    <span className="text-muted-foreground">{msg.hint}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
