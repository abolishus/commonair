// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { ChannelAvatar } from "../primitives/channel-avatar.tsx";
import { Button } from "@commonair/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";

export interface UserMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  href?: string;
  render?: React.ReactElement;
  onSelect?: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  testId?: string;
}
export interface UserMenuProps extends React.ComponentProps<"div"> {
  username: string;
  avatar?: string | null;
  menuLabel: string;
  items: UserMenuItem[];
}
export function UserMenu({ username, avatar, menuLabel, items, ...props }: UserMenuProps): React.JSX.Element {
  return (
    <div {...props}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={menuLabel} />}>
          <ChannelAvatar name={username} src={avatar} size="sm" decorative />
          <span className="hidden max-w-32 truncate sm:inline">{username}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((item) => (
            <React.Fragment key={item.id}>
              {item.separatorBefore ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                render={item.render ?? (item.href ? <a href={item.href}>{item.label}</a> : undefined)}
                onClick={item.onSelect}
                variant={item.destructive ? "destructive" : "default"}
                data-testid={item.testId}
              >
                {item.icon}
                {item.label}
              </DropdownMenuItem>
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
