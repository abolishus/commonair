// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the site chrome links to, as data: the header nav, the account menu, the creator studio
 * sidebar and the footer. Only pages that exist are listed (no dead UI); `current` is derived from
 * the pathname here so the components stay router-agnostic.
 */

export interface SiteNavEntry {
  id: "directory";
  to: "/";
  current: boolean;
}

export interface AccountEntry {
  id: "dashboard" | "relays" | "subscriptions" | "treasury" | "signOut";
  /** Absent for actions (sign out). */
  to?: "/dashboard" | "/relays" | "/settings/subscriptions" | "/treasury";
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface SignedOutEntry {
  id: "signIn" | "signUp";
  to: "/signin" | "/signup";
  current: boolean;
}

export interface StudioEntry {
  id: "streamManager" | "revenue" | "relays";
  to: "/dashboard" | "/revenue" | "/relays";
  current: boolean;
}

export interface FooterEntry {
  id: "transparency";
  to: "/transparency";
}

export interface AccountMenuOptions {
  /** Platform treasurers also get the treasury. */
  treasurer?: boolean;
}

/** Trailing slashes do not change the page (`/relays/` is `/relays`). */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function siteNav(pathname: string): SiteNavEntry[] {
  return [{ id: "directory", to: "/", current: normalize(pathname) === "/" }];
}

/** Signed in: the account menu. Signed out: sign-in / sign-up links. */
export function accountMenu(signedIn: true, options?: AccountMenuOptions): AccountEntry[];
export function accountMenu(signedIn: false, pathname: string): SignedOutEntry[];
export function accountMenu(
  signedIn: boolean,
  arg: string | AccountMenuOptions = {},
): AccountEntry[] | SignedOutEntry[] {
  if (signedIn) {
    const treasurer = typeof arg !== "string" && arg.treasurer === true;
    const treasury: AccountEntry[] = treasurer ? [{ id: "treasury", to: "/treasury" }] : [];
    return [
      { id: "dashboard", to: "/dashboard" },
      { id: "relays", to: "/relays" },
      { id: "subscriptions", to: "/settings/subscriptions" },
      ...treasury,
      { id: "signOut", separatorBefore: true, destructive: true },
    ];
  }
  const path = normalize(typeof arg === "string" ? arg : "/");
  return [
    { id: "signIn", to: "/signin", current: path === "/signin" },
    { id: "signUp", to: "/signup", current: path === "/signup" },
  ];
}

export function studioNav(pathname: string): StudioEntry[] {
  const path = normalize(pathname);
  return [
    { id: "streamManager", to: "/dashboard", current: path === "/dashboard" },
    { id: "revenue", to: "/revenue", current: path === "/revenue" },
    { id: "relays", to: "/relays", current: path === "/relays" },
  ];
}

/** Public pages linked from every footer. */
export function footerNav(): FooterEntry[] {
  return [{ id: "transparency", to: "/transparency" }];
}
