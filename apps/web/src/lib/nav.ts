// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the site chrome links to, as data: the header nav, the account menu and the creator studio
 * sidebar. Only pages that exist are listed (no dead UI); `current` is derived from the pathname
 * here so the components stay router-agnostic.
 */

export interface SiteNavEntry {
  id: "directory";
  to: "/";
  current: boolean;
}

export interface AccountEntry {
  id: "dashboard" | "relays" | "signOut";
  /** Absent for actions (sign out). */
  to?: "/dashboard" | "/relays";
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface SignedOutEntry {
  id: "signIn" | "signUp";
  to: "/signin" | "/signup";
  current: boolean;
}

export interface StudioEntry {
  id: "streamManager" | "relays";
  to: "/dashboard" | "/relays";
  current: boolean;
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
export function accountMenu(signedIn: true): AccountEntry[];
export function accountMenu(signedIn: false, pathname: string): SignedOutEntry[];
export function accountMenu(signedIn: boolean, pathname = "/"): AccountEntry[] | SignedOutEntry[] {
  if (signedIn)
    return [
      { id: "dashboard", to: "/dashboard" },
      { id: "relays", to: "/relays" },
      { id: "signOut", separatorBefore: true, destructive: true },
    ];
  const path = normalize(pathname);
  return [
    { id: "signIn", to: "/signin", current: path === "/signin" },
    { id: "signUp", to: "/signup", current: path === "/signup" },
  ];
}

export function studioNav(pathname: string): StudioEntry[] {
  const path = normalize(pathname);
  return [
    { id: "streamManager", to: "/dashboard", current: path === "/dashboard" },
    { id: "relays", to: "/relays", current: path === "/relays" },
  ];
}
