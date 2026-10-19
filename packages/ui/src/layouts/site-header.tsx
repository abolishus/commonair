// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Separator } from "@commonair/ui/components/separator";
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
/** The area of the site after the brand ("Creator studio", "Admin"): `href`, or a router `render` element. */
export interface HeaderContext {
  label: string;
  href?: string;
  render?: React.ReactElement;
}
export interface SiteHeaderProps extends React.ComponentProps<"header"> {
  brand: Brand;
  /** Shown after the brand, separated by a rule; also heads the mobile sheet. */
  context?: HeaderContext;
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
  context,
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
      {context ? (
        <>
          <Separator orientation="vertical" className="hidden h-4 self-center sm:block" />
          <ContextLink context={context} className="hidden min-w-0 truncate text-sm font-medium sm:block" />
        </>
      ) : null}
      {nav.length ? (
        <nav aria-label={navLabel} className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
          {nav.map((item) => (
            <NavLink key={item.id} item={item} className={buttonVariants({ variant: "ghost", size: "sm" })} />
          ))}
        </nav>
      ) : null}
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
          {context ? (
            <ContextLink
              context={context}
              className="mx-4 flex min-h-10 items-center px-2 py-2 text-sm font-medium hover:bg-muted"
            />
          ) : null}
          {nav.length ? (
            <nav aria-label={navLabel} className="flex flex-col gap-2 px-4">
              {nav.map((item) => (
                <NavLink key={item.id} item={item} className="min-h-10 rounded-none px-2 py-2 hover:bg-muted" />
              ))}
            </nav>
          ) : null}
          {search ? <div className="p-4">{search}</div> : null}
          {mobileActions ? <div className="flex flex-wrap items-center gap-2 p-4">{mobileActions}</div> : null}
        </SheetContent>
      </Sheet>
    </header>
  );
}

function ContextLink({ context, className }: { context: HeaderContext; className: string }): React.JSX.Element {
  const props = { className, "data-slot": "site-header-context" };
  if (context.render)
    return React.cloneElement(context.render as React.ReactElement<{ className?: string }>, props, context.label);
  return (
    <a href={context.href} {...props}>
      {context.label}
    </a>
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
