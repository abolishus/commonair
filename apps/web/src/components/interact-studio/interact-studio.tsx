// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/interact`: polls, predictions, raids (and the raid policy) and goals for one channel. Owners
 * and editors get everything; moderators get polls, predictions and the goal list (ADR 0026, the
 * contract's `access`). One load for the page; each section then refreshes what it shows.
 */
import { SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import {
  interactAbilities,
  type GoalDto,
  type PollDto,
  type PredictionDto,
  type RaidStateDto,
  type StudioRole,
} from "../../lib/interact-studio.ts";
import { useLoad } from "../money/use-load.ts";
import { GoalPanel } from "./goal-panel.tsx";
import { PollPanel } from "./poll-panel.tsx";
import { PredictionPanel } from "./prediction-panel.tsx";
import { RaidPanel } from "./raid-panel.tsx";
import { StudioLoadError, type StudioApi } from "./shared.tsx";
import { StudioAccess, type StudioMe } from "./studio-access.tsx";

export interface InteractData {
  poll: PollDto | null;
  prediction: PredictionDto | null;
  /** Null for moderators (raids are owner-only). */
  raids: RaidStateDto | null;
  goals: GoalDto[];
}

export async function loadInteract(client: StudioApi, channel: string, role: StudioRole): Promise<InteractData> {
  const i = client.interact;
  const [poll, prediction, raids, goals] = await Promise.all([
    i.polls.current({ channel }),
    i.predictions.current({ channel }),
    interactAbilities(role).raids ? i.raids.current({ channel }) : Promise.resolve(null),
    i.goals.list({ channel }),
  ]);
  return { poll, prediction, raids, goals };
}

function InteractLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <StudioLoadError
      data-testid="interact-load-error"
      message={t("interact.loadFailed")}
      retry={
        <Button type="button" variant="outline" size="sm" data-testid="interact-retry" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

export interface InteractStudioProps {
  me: StudioMe;
  channel: string;
  currency: string;
  client?: StudioApi;
  /** Live-card refresh interval (tests shorten it). */
  refreshMs?: number;
}

export function InteractStudio({ me, channel, currency, client, refreshMs }: InteractStudioProps): React.JSX.Element {
  const c = client ?? api();
  return (
    <StudioAccess
      me={me}
      channel={channel}
      client={c}
      home="/interact"
      loadError={(retry) => <InteractLoadError onRetry={retry} />}
    >
      {(role) => (
        <InteractSections channel={channel} role={role} currency={currency} client={c} refreshMs={refreshMs} />
      )}
    </StudioAccess>
  );
}

function InteractSections({
  channel,
  role,
  currency,
  client,
  refreshMs,
}: {
  channel: string;
  role: StudioRole;
  currency: string;
  client: StudioApi;
  refreshMs?: number;
}): React.JSX.Element {
  const loaded = useLoad(`interact:${channel}:${role}`, () => loadInteract(client, channel, role));
  if (loaded.data === null && loaded.failed) return <InteractLoadError onRetry={loaded.reload} />;
  if (loaded.data === null)
    return (
      <SkeletonGroup label={t("interact.loading")}>
        <ResponsiveGrid cols={2}>
          <SkeletonText lines={8} />
          <SkeletonText lines={8} />
        </ResponsiveGrid>
      </SkeletonGroup>
    );
  const data = loaded.data;
  const abilities = interactAbilities(role);
  return (
    <ResponsiveGrid cols={2} className="items-start" data-role={role}>
      <PollPanel channel={channel} initial={data.poll} client={client} refreshMs={refreshMs} />
      <PredictionPanel channel={channel} initial={data.prediction} client={client} refreshMs={refreshMs} />
      {abilities.raids && data.raids ? (
        <RaidPanel channel={channel} initial={data.raids} client={client} refreshMs={refreshMs} />
      ) : null}
      <GoalPanel
        channel={channel}
        initial={data.goals}
        client={client}
        currency={currency}
        canManage={abilities.manageGoals}
        refreshMs={refreshMs}
      />
    </ResponsiveGrid>
  );
}
