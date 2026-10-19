// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { ChannelAvatar } from "../primitives/channel-avatar.tsx";
import { ViewerCount } from "../primitives/viewer-count.tsx";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@commonair/ui/components/sidebar";

export interface ChannelItem {
  id: string;
  name: string;
  category: string;
  href: string;
  viewers?: number;
  live?: boolean;
  accent?: React.ComponentProps<typeof ChannelAvatar>["accent"];
}
export interface ChannelNavGroup {
  id: string;
  label: string;
  channels: ChannelItem[];
}
export interface ChannelSidebarProps extends React.ComponentProps<"nav"> {
  label: string;
  groups: ChannelNavGroup[];
  callout?: React.ReactNode;
}
export function ChannelSidebar({ label, groups, callout, ...props }: ChannelSidebarProps): React.JSX.Element {
  return (
    <nav aria-label={label} {...props}>
      {groups.map((group) => (
        <SidebarGroup key={group.id}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu>
            {group.channels.map((channel) => (
              <SidebarMenuItem key={channel.id}>
                <SidebarMenuButton render={<a href={channel.href}>{channel.name}</a>} tooltip={channel.name}>
                  <ChannelAvatar name={channel.name} accent={channel.accent} size="sm" live={channel.live} decorative />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{channel.name}</span>
                    <span className="truncate text-muted-foreground">{channel.category}</span>
                  </span>
                  {channel.live && channel.viewers !== undefined ? <ViewerCount count={channel.viewers} /> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      {callout ? (
        <Alert>
          <AlertDescription>{callout}</AlertDescription>
        </Alert>
      ) : null}
    </nav>
  );
}
