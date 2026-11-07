// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { cn } from "@commonair/ui/lib/utils";

export interface TabBarItem {
  id: string;
  /** Always visible under the icon: a tab bar of bare icons is guesswork. */
  label: string;
  /** Sized by the caller (22 px in the mockups). */
  icon: React.ReactNode;
  href?: string;
  /** Router link element (Base UI `render` convention); `href` stays the fallback. */
  render?: React.ReactElement;
  /** Neither `href` nor `render`: a button (it opens a sheet, say). */
  onSelect?: () => void;
  /** A button's popup state, for `aria-expanded`. */
  expanded?: boolean;
  current?: boolean;
  testId?: string;
}

export interface BottomTabBarProps extends Omit<React.ComponentProps<"nav">, "children"> {
  label: string;
  items: TabBarItem[];
  /** Out of the way for now (the on-screen keyboard is open): not rendered, not focusable. */
  hidden?: boolean;
}

// The current section gets the foreground and a 2 px rule on top (the rule is there, transparent,
// on every tab, so marking one moves nothing).
const ITEM =
  "flex h-full min-h-12 w-full flex-col items-center justify-center gap-0.5 border-t-2 border-transparent px-1 text-xs font-medium text-muted-foreground outline-none " +
  "transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset " +
  "aria-[current=page]:border-foreground aria-[current=page]:text-foreground aria-expanded:text-foreground";

const COLUMNS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5"] as const;

/**
 * The phone's section bar (below `md`, browsing pages only): fixed to the bottom, 56 px, on the
 * raised surface, with labels always shown and the current section marked `aria-current="page"`.
 * The shell pads the page by the same height so nothing hides under it.
 */
export function BottomTabBar({
  label,
  items,
  hidden = false,
  className,
  ...props
}: BottomTabBarProps): React.JSX.Element {
  const columns = COLUMNS[Math.min(Math.max(items.length, 1), COLUMNS.length) - 1];
  return (
    <nav
      aria-label={label}
      data-slot="bottom-tab-bar"
      hidden={hidden}
      className={cn(
        // The popover surface until the art direction's raised surface token lands.
        "fixed inset-x-0 bottom-0 z-30 border-t bg-popover text-popover-foreground md:hidden",
        hidden && "hidden",
        className,
      )}
      {...props}
    >
      <ul className={cn("grid h-14", columns)}>
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0">
            <TabBarEntry item={item} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TabBarEntry({ item }: { item: TabBarItem }): React.JSX.Element {
  const content = (
    <>
      {item.icon}
      <span className="max-w-full truncate">{item.label}</span>
    </>
  );
  const shared = { "data-tab": item.id, "data-testid": item.testId };
  if (!item.render && !item.href)
    return (
      <Button
        variant="ghost"
        {...shared}
        className={cn(ITEM, "h-full rounded-none hover:bg-transparent")}
        aria-haspopup="dialog"
        aria-expanded={item.expanded ?? false}
        onClick={item.onSelect}
      >
        {content}
      </Button>
    );
  const current = item.current ? ("page" as const) : undefined;
  if (item.render) {
    const element = item.render as React.ReactElement<React.ComponentProps<"a">>;
    return React.cloneElement(
      element,
      { ...shared, "aria-current": current, className: cn(element.props.className, ITEM) },
      content,
    );
  }
  return (
    <a href={item.href} {...shared} aria-current={current} className={ITEM}>
      {content}
    </a>
  );
}
