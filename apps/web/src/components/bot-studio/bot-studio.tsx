// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/bot`: the channel bot for one channel. Owners and editors get the settings; moderators get
 * commands, timers, variables, song requests and points adjust (the contract's `access`). One
 * load for the page; each section keeps its own state after that.
 */
import { SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import {
  botAbilities,
  type BotCommandDto,
  type BotSettingsDto,
  type BotTimerDto,
  type BotVariableDto,
  type LoyaltyRowDto,
  type SongRequestDto,
} from "../../lib/bot-studio.ts";
import type { StudioRole } from "../../lib/interact-studio.ts";
import { StudioLoadError, type StudioApi } from "../interact-studio/shared.tsx";
import { StudioAccess, type StudioMe } from "../interact-studio/studio-access.tsx";
import { useLoad } from "../money/use-load.ts";
import { CommandsPanel } from "./commands-panel.tsx";
import { LEADERBOARD_SIZE, PointsPanel } from "./points-panel.tsx";
import { BotSettingsPanel } from "./settings-panel.tsx";
import { SongRequestsPanel } from "./song-requests-panel.tsx";
import { TimersPanel } from "./timers-panel.tsx";
import { VariablesPanel } from "./variables-panel.tsx";

export interface BotData {
  /** Null for moderators (settings are owner-only). */
  settings: BotSettingsDto | null;
  commands: BotCommandDto[];
  timers: BotTimerDto[];
  variables: BotVariableDto[];
  songRequests: SongRequestDto[];
  leaderboard: LoyaltyRowDto[];
}

export async function loadBot(client: StudioApi, channel: string, role: StudioRole): Promise<BotData> {
  const b = client.bot;
  const [settings, commands, timers, variables, songRequests, leaderboard] = await Promise.all([
    botAbilities(role).settings ? b.settings({ channel }) : Promise.resolve(null),
    b.commands.list({ channel }),
    b.timers.list({ channel }),
    b.variables.list({ channel }),
    b.songRequests.list({ channel }),
    b.points.leaderboard({ channel, limit: LEADERBOARD_SIZE }),
  ]);
  return { settings, commands, timers, variables, songRequests, leaderboard };
}

function BotLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <StudioLoadError
      data-testid="bot-load-error"
      message={t("bot.loadFailed")}
      retry={
        <Button type="button" variant="outline" size="sm" data-testid="bot-retry" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

export interface BotStudioProps {
  me: StudioMe;
  channel: string;
  client?: StudioApi;
}

export function BotStudio({ me, channel, client }: BotStudioProps): React.JSX.Element {
  const c = client ?? api();
  return (
    <StudioAccess
      me={me}
      channel={channel}
      client={c}
      home="/bot"
      loadError={(retry) => <BotLoadError onRetry={retry} />}
    >
      {(role) => <BotSections channel={channel} role={role} client={c} />}
    </StudioAccess>
  );
}

function BotSections({
  channel,
  role,
  client,
}: {
  channel: string;
  role: StudioRole;
  client: StudioApi;
}): React.JSX.Element {
  const loaded = useLoad(`bot:${channel}:${role}`, () => loadBot(client, channel, role));
  if (loaded.data === null && loaded.failed) return <BotLoadError onRetry={loaded.reload} />;
  if (loaded.data === null)
    return (
      <SkeletonGroup label={t("bot.loading")}>
        <ResponsiveGrid cols={2}>
          <SkeletonText lines={10} />
          <SkeletonText lines={10} />
        </ResponsiveGrid>
      </SkeletonGroup>
    );
  const d = loaded.data;
  return (
    <ResponsiveGrid cols={2} className="items-start" data-role={role}>
      {d.settings ? <BotSettingsPanel channel={channel} initial={d.settings} client={client} /> : null}
      <CommandsPanel channel={channel} initial={d.commands} client={client} canEdit />
      <TimersPanel channel={channel} initial={d.timers} client={client} />
      <VariablesPanel channel={channel} initial={d.variables} client={client} />
      <SongRequestsPanel channel={channel} initial={d.songRequests} client={client} />
      <PointsPanel channel={channel} initial={d.leaderboard} client={client} canAdjust />
    </ResponsiveGrid>
  );
}
