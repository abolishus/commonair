// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The member's account menu (F14): the layout's `UserMenu` items, plus the theme as a radio group
 * so the switcher leaves the header. Visitors get the theme at the bottom of the mobile sheet.
 */
import { ChannelAvatar, isTheme, THEMES, useUiMessages, type Theme } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import type { UserMenuItem } from "@commonair/ui/layouts";
import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";

const THEME_ICONS = { dark: Moon02Icon, light: Sun03Icon, system: ComputerIcon } as const;

export interface AccountMenuProps {
  username: string;
  avatar?: string | null;
  menuLabel: string;
  items: UserMenuItem[];
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  "data-testid"?: string;
  "data-username"?: string;
}

export function AccountMenu({
  username,
  avatar,
  menuLabel,
  items,
  theme,
  onThemeChange,
  ...props
}: AccountMenuProps): React.JSX.Element {
  const messages = useUiMessages();
  // The theme sits just above the first separated item (sign out).
  const split = items.findIndex((item) => item.separatorBefore);
  const before = split < 0 ? items : items.slice(0, split);
  const after = split < 0 ? [] : items.slice(split);
  return (
    <div {...props}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={menuLabel} />}>
          <ChannelAvatar name={username} src={avatar} size="sm" decorative />
          <span className="hidden max-w-32 truncate sm:inline">{username}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {before.map((item) => (
            <MenuItem key={item.id} item={item} />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{messages.theme.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              data-testid="account-theme-switcher"
              value={theme}
              onValueChange={(value: unknown) => {
                if (isTheme(value) && value !== theme) onThemeChange(value);
              }}
            >
              {THEMES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} data-theme-option={option}>
                  <HugeiconsIcon icon={THEME_ICONS[option]} strokeWidth={2} aria-hidden />
                  {messages.theme[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {after.map((item) => (
            <MenuItem key={item.id} item={item} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MenuItem({ item }: { item: UserMenuItem }): React.JSX.Element {
  return (
    <>
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
    </>
  );
}
