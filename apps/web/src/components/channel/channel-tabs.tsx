// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's tabs (F2; `channel-tabs`, `channel-tab-<id>`): Home, Videos, Clips, About, under
 * the header. The route owns the value (`?tab=`), so every tab is a link and Back steps through
 * them; this component only reports a choice. Arrow keys move between tabs (Base UI), Tab moves
 * into the panel. Only the active panel is mounted.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { CHANNEL_TABS, isChannelTab, type ChannelTab } from "./channel-data.ts";

function tabLabel(tab: ChannelTab): string {
  switch (tab) {
    case "home":
      return t("channel.tabs.home");
    case "videos":
      return t("channel.tabs.videos");
    case "clips":
      return t("channel.tabs.clips");
    case "about":
      return t("channel.tabs.about");
  }
}

export interface ChannelTabsProps {
  tab: ChannelTab;
  onTabChange: (tab: ChannelTab) => void;
  panels: Record<ChannelTab, React.ReactNode>;
}

export function ChannelTabs({ tab, onTabChange, panels }: ChannelTabsProps): React.JSX.Element {
  return (
    <Tabs
      data-testid="channel-tabs"
      data-tab={tab}
      value={tab}
      onValueChange={(next: unknown) => {
        if (isChannelTab(next) && next !== tab) onTabChange(next);
      }}
      className="min-w-0 gap-4"
    >
      <div className="min-w-0 overflow-x-auto border-b">
        <TabsList variant="line" aria-label={t("channel.tabs.label")} className="h-10">
          {CHANNEL_TABS.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`channel-tab-${id}`} className="px-3 text-sm">
              {tabLabel(id)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {CHANNEL_TABS.map((id) => (
        <TabsContent key={id} value={id} data-testid={`channel-panel-${id}`} className="min-w-0 text-sm">
          {id === tab ? panels[id] : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
