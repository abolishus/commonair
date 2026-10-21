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
  id: "dashboard" | "relays" | "subscriptions" | "appeals" | "treasury" | "moderation" | "legal" | "signOut";
  /** Absent for actions (sign out). */
  to?:
    | "/dashboard"
    | "/relays"
    | "/settings/subscriptions"
    | "/settings/appeals"
    | "/treasury"
    | "/admin/moderation"
    | "/admin/legal";
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
  id: "transparency" | "takedown";
  to: "/transparency" | "/takedown";
}

export interface AccountMenuOptions {
  /** Platform treasurers also get the treasury. */
  treasurer?: boolean;
  /** Platform moderators, admins and `legal` also get the mod queue. */
  safetyStaff?: boolean;
  /** The `legal` role also gets the legal queue. */
  legal?: boolean;
}

export interface AdminEntry {
  id: "treasury" | "moderation" | "appeals" | "legal";
  to: "/treasury" | "/admin/moderation" | "/admin/appeals" | "/admin/legal";
  current: boolean;
}

export interface AdminNavOptions {
  treasurer?: boolean;
  /** Moderators, admins and `legal`: the mod queue. */
  safetyStaff?: boolean;
  /** Moderators and admins: the appeals queue. */
  platformModerator?: boolean;
  legal?: boolean;
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
    const options = typeof arg === "string" ? {} : arg;
    const staff: AccountEntry[] = [
      ...(options.treasurer === true ? [{ id: "treasury", to: "/treasury" } as const] : []),
      ...(options.safetyStaff === true ? [{ id: "moderation", to: "/admin/moderation" } as const] : []),
      ...(options.legal === true ? [{ id: "legal", to: "/admin/legal" } as const] : []),
    ];
    return [
      { id: "dashboard", to: "/dashboard" },
      { id: "relays", to: "/relays" },
      { id: "subscriptions", to: "/settings/subscriptions" },
      { id: "appeals", to: "/settings/appeals" },
      ...staff,
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
  return [
    { id: "transparency", to: "/transparency" },
    { id: "takedown", to: "/takedown" },
  ];
}

/** The platform-tools sidebar: only the pages the role may open. */
export function adminNav(pathname: string, options: AdminNavOptions): AdminEntry[] {
  const path = normalize(pathname);
  const entries: Omit<AdminEntry, "current">[] = [
    ...(options.treasurer === true ? [{ id: "treasury", to: "/treasury" } as const] : []),
    ...(options.safetyStaff === true ? [{ id: "moderation", to: "/admin/moderation" } as const] : []),
    ...(options.platformModerator === true ? [{ id: "appeals", to: "/admin/appeals" } as const] : []),
    ...(options.legal === true ? [{ id: "legal", to: "/admin/legal" } as const] : []),
  ];
  return entries.map((entry) => ({ ...entry, current: path === entry.to }));
}
