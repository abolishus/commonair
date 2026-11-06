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
import { TargetLink, type LinkTarget } from "../lib/link.tsx";

export interface Brand {
  mark: React.ReactNode;
  name: string;
  href: string;
  /** Router link element (Base UI `render` convention); `href` stays the fallback. */
  render?: React.ReactElement;
}
/** The area of the site after the brand ("Creator studio", "Admin"): `href`, or a router `render` element. */
export type HeaderContext = LinkTarget & { label: string };
export interface SiteHeaderProps extends React.ComponentProps<"header"> {
  brand: Brand;
  /** Shown after the brand, separated by a rule; also heads the mobile sheet. */
  context?: HeaderContext;
  nav: NavItem[];
  navLabel: string;
  /** From `lg` it sits in the middle column, centred on the page; first in the mobile sheet. */
  search?: React.ReactNode;
  searchLabel?: string;
  onOpenPalette?: () => void;
  actions?: React.ReactNode;
  user?: React.ReactNode;
  menuLabel: string;
  /** The mobile sheet's open state: controlled with `onMobileMenuOpenChange`, otherwise the initial state. */
  mobileMenuOpen?: boolean;
  onMobileMenuOpenChange?: (open: boolean) => void;
  /**
   * A key for the router's current location: pass the full href (path, search and hash), not only
   * the pathname, so a search submitted on /search still counts. The mobile sheet closes when it
   * changes, which covers navigation that is not a link click (a search submit, a redirect).
   */
  locationKey?: string;
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
  onMobileMenuOpenChange,
  locationKey,
  mobileActions,
  desktopActions,
  className,
  ...props
}: SiteHeaderProps): React.JSX.Element {
  const [openState, setOpenState] = React.useState(mobileMenuOpen ?? false);
  const controlled = mobileMenuOpen !== undefined && onMobileMenuOpenChange !== undefined;
  const open = controlled ? mobileMenuOpen : openState;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setOpenState(next);
      onMobileMenuOpenChange?.(next);
    },
    [controlled, onMobileMenuOpenChange],
  );
  // Close when the location changes; not on mount, where a caller may open the sheet on purpose.
  const lastLocation = React.useRef(locationKey);
  // Read by the effect below, so a change of `open` alone does not re-run it. Declared first, so it
  // is current by the time that effect runs.
  const openRef = React.useRef(open);
  React.useEffect(() => {
    openRef.current = open;
  }, [open]);
  React.useEffect(() => {
    if (lastLocation.current === locationKey) return;
    lastLocation.current = locationKey;
    // Only an open sheet is closed, so a controlled caller hears nothing on ordinary navigation.
    if (openRef.current) setOpen(false);
  }, [locationKey, setOpen]);
  // Any link activated in the sheet closes it, whatever the router. A modified click opens another
  // tab and leaves this page, and the sheet, as they are.
  const onSheetClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
  };
  return (
    <header
      aria-label={brand.name}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 border-b bg-background px-4",
        // From lg three equal columns: the search owns the middle one, centred whatever the nav's width.
        search && "lg:grid lg:grid-cols-3",
        className,
      )}
      {...props}
    >
      <div data-slot="site-header-start" className="flex min-w-0 flex-1 items-center gap-3">
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
      </div>
      {search ? (
        <div
          data-slot="site-header-search"
          className="hidden min-w-0 md:block lg:col-start-2 lg:w-full lg:max-w-md lg:justify-self-center"
        >
          {search}
        </div>
      ) : null}
      <div
        data-slot="site-header-end"
        className="ms-auto flex shrink-0 items-center gap-3 lg:col-start-3 lg:justify-self-end"
      >
        {onOpenPalette ? (
          <Button aria-label={searchLabel} variant="ghost" size="icon" className="md:hidden" onClick={onOpenPalette}>
            <HugeiconsIcon icon={Search01Icon} />
          </Button>
        ) : null}
        <div className="flex shrink-0 items-center gap-2">
          {desktopActions ? <div className="hidden items-center gap-2 md:flex">{desktopActions}</div> : null}
          {actions}
          {user}
        </div>
        <Sheet open={open} onOpenChange={(next) => setOpen(next)}>
          <SheetTrigger
            className={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}
            aria-label={menuLabel}
          >
            <HugeiconsIcon icon={Menu01Icon} />
          </SheetTrigger>
          <SheetContent side="left" className="md:hidden" onClick={onSheetClick}>
            <SheetHeader>
              <SheetTitle>{brand.name}</SheetTitle>
            </SheetHeader>
            {search ? (
              <div data-slot="site-header-sheet-search" className="px-4 pb-2">
                {search}
              </div>
            ) : null}
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
            {mobileActions ? <div className="flex flex-wrap items-center gap-2 p-4">{mobileActions}</div> : null}
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}

function ContextLink({ context, className }: { context: HeaderContext; className: string }): React.JSX.Element {
  return (
    <TargetLink target={context} className={className} data-slot="site-header-context">
      {context.label}
    </TargetLink>
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
