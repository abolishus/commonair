// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@commonair/ui/components/sheet";
import { Search01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { NavLink, type NavItem } from "./nav.tsx";
import { cn } from "@commonair/ui/lib/utils";

export interface Brand {
  mark: React.ReactNode;
  name: string;
  href: string;
  /** Router link element (Base UI `render` convention); `href` stays the fallback. */
  render?: React.ReactElement;
}
export interface SiteHeaderProps extends React.ComponentProps<"header"> {
  brand: Brand;
  nav: NavItem[];
  navLabel: string;
  search?: React.ReactNode;
  searchLabel?: string;
  onOpenPalette?: () => void;
  actions?: React.ReactNode;
  user?: React.ReactNode;
  menuLabel: string;
  mobileMenuOpen?: boolean;
  /** Shown at the bottom of the mobile sheet (theme switch, account links). */
  mobileActions?: React.ReactNode;
  /** Shown in the bar from `md` up only; pair with `mobileActions` for the same controls on phones. */
  desktopActions?: React.ReactNode;
}
export function SiteHeader({
  brand,
  nav,
  navLabel,
  search,
  searchLabel,
  onOpenPalette,
  actions,
  user,
  menuLabel,
  mobileMenuOpen,
  mobileActions,
  desktopActions,
  className,
  ...props
}: SiteHeaderProps): React.JSX.Element {
  return (
    <header
      aria-label={brand.name}
      className={cn("flex min-h-14 w-full items-center gap-3 border-b bg-background px-4", className)}
      {...props}
    >
      <BrandLink brand={brand} />
      <nav aria-label={navLabel} className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
        {nav.map((item) => (
          <NavLink key={item.id} item={item} className={buttonVariants({ variant: "ghost", size: "sm" })} />
        ))}
      </nav>
      {search ? <div className="hidden min-w-0 md:block">{search}</div> : null}
      {onOpenPalette ? (
        <Button aria-label={searchLabel} variant="ghost" size="icon" className="md:hidden" onClick={onOpenPalette}>
          <HugeiconsIcon icon={Search01Icon} />
        </Button>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {desktopActions ? <div className="hidden items-center gap-2 md:flex">{desktopActions}</div> : null}
        {actions}
        {user}
      </div>
      <Sheet open={mobileMenuOpen}>
        <SheetTrigger
          className={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}
          aria-label={menuLabel}
        >
          <HugeiconsIcon icon={Menu01Icon} />
        </SheetTrigger>
        <SheetContent side="left" className="md:hidden">
          <SheetHeader>
            <SheetTitle>{brand.name}</SheetTitle>
          </SheetHeader>
          <nav aria-label={navLabel} className="flex flex-col gap-2 px-4">
            {nav.map((item) => (
              <NavLink key={item.id} item={item} className="min-h-10 rounded-none px-2 py-2 hover:bg-muted" />
            ))}
          </nav>
          {search ? <div className="p-4">{search}</div> : null}
          {mobileActions ? <div className="flex flex-wrap items-center gap-2 p-4">{mobileActions}</div> : null}
        </SheetContent>
      </Sheet>
    </header>
  );
}

function BrandLink({ brand }: { brand: Brand }): React.JSX.Element {
  const className = "flex min-w-0 shrink items-center gap-2 font-semibold";
  const content = (
    <>
      {brand.mark}
      <span className="truncate">{brand.name}</span>
    </>
  );
  if (brand.render)
    return React.cloneElement(brand.render as React.ReactElement<{ className?: string }>, { className }, content);
  return (
    <a href={brand.href} className={className}>
      {content}
    </a>
  );
}
