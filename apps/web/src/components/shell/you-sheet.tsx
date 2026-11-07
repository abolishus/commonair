// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ThemeToggle } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Separator } from "@commonair/ui/components/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@commonair/ui/components/sheet";
import type { UserMenuItem } from "@commonair/ui/layouts";
import { cn } from "@commonair/ui/lib/utils";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { ThemeContext } from "../../lib/theme-context.ts";

const ROW =
  "flex min-h-11 w-full items-center gap-3 px-4 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * The member's You tab on phones: the account menu's entries as a bottom sheet with 44 px rows,
 * the theme, then Sign out after a rule (the same order as the header's account menu).
 */
export function YouSheet({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: UserMenuItem[];
}): React.JSX.Element {
  const { theme, setTheme } = React.useContext(ThemeContext);
  const split = items.findIndex((item) => item.separatorBefore);
  const before = split < 0 ? items : items.slice(0, split);
  const after = split < 0 ? [] : items.slice(split);
  // A link activated in the sheet closes it; a modified click opens another tab and leaves it open.
  const onClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={(next) => onOpenChange(next)}>
      <SheetContent
        side="bottom"
        data-testid="you-sheet"
        className="max-h-svh overflow-y-auto pb-4 md:hidden"
        onClick={onClick}
      >
        <SheetHeader>
          <SheetTitle>{t("shell.you.title")}</SheetTitle>
        </SheetHeader>
        <ul className="flex flex-col">
          {before.map((item) => (
            <li key={item.id}>
              <SheetRow item={item} />
            </li>
          ))}
        </ul>
        <div className="px-4 py-3">
          <ThemeToggle value={theme} onValueChange={setTheme} />
        </div>
        {after.map((item) => (
          <React.Fragment key={item.id}>
            {item.separatorBefore ? <Separator /> : null}
            <SheetRow item={item} />
          </React.Fragment>
        ))}
      </SheetContent>
    </Sheet>
  );
}

function SheetRow({ item }: { item: UserMenuItem }): React.JSX.Element {
  const className = cn(ROW, item.destructive && "text-destructive");
  const content = (
    <>
      {item.icon}
      {item.label}
    </>
  );
  if (item.render) {
    const element = item.render as React.ReactElement<{ className?: string; "data-testid"?: string }>;
    // The menu's test ids stay on the menu; the sheet's rows carry their own.
    return React.cloneElement(
      element,
      { className: cn(element.props.className, className), "data-testid": `you-${item.id}` },
      content,
    );
  }
  if (item.href)
    return (
      <a href={item.href} className={className} data-testid={`you-${item.id}`}>
        {content}
      </a>
    );
  return (
    <Button
      variant="ghost"
      className={cn(className, "h-auto justify-start rounded-none")}
      data-testid={`you-${item.id}`}
      onClick={item.onSelect}
    >
      {content}
    </Button>
  );
}
