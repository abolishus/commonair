// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
// A static note, not an announcement: AlertCallout is role="note" where a bare Alert is role="alert".
import { AlertCallout } from "../blocks/feedback/alert-callout.tsx";
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
/** A "Show all 38 followed" link under a group: `href`, or a router `render` element. */
export interface ChannelGroupLink {
  label: string;
  href?: string;
  render?: React.ReactElement;
}
export interface ChannelNavGroup {
  id: string;
  label: string;
  channels: ChannelItem[];
  moreLink?: ChannelGroupLink;
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
            {group.moreLink ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  data-more-link=""
                  tooltip={group.moreLink.label}
                  render={group.moreLink.render ?? <a href={group.moreLink.href}>{group.moreLink.label}</a>}
                >
                  <span>{group.moreLink.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      {callout ? <AlertCallout icon={null} description={callout} /> : null}
    </nav>
  );
}
