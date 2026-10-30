// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the site chrome links to, as data: the header nav, the account menu, the creator studio
 * sidebar and the footer. Only pages that exist are listed (no dead UI); `current` is derived from
 * the pathname here so the components stay router-agnostic.
 */

export interface SiteNavEntry {
  id: "directory" | "coop";
  to: "/" | "/coop";
  current: boolean;
}

export interface AccountEntry {
  id:
    | "dashboard"
    | "relays"
    | "subscriptions"
    | "notifications"
    | "appeals"
    | "copyright"
    | "privacy"
    | "connections"
    | "coop"
    | "treasury"
    | "moderation"
    | "legal"
    | "adminCoop"
    | "signOut";
  /** Absent for actions (sign out). */
  to?:
    | "/dashboard"
    | "/relays"
    | "/settings/subscriptions"
    | "/settings/notifications"
    | "/settings/appeals"
    | "/settings/copyright"
    | "/settings/privacy"
    | "/settings/connections"
    | "/coop/membership"
    | "/treasury"
    | "/admin/moderation"
    | "/admin/legal"
    | "/admin/coop";
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface SignedOutEntry {
  id: "signIn" | "signUp";
  to: "/signin" | "/signup";
  current: boolean;
}

export interface StudioEntry {
  id: "streamManager" | "overlays" | "interact" | "bot" | "chat" | "content" | "revenue" | "relays" | "developer";
  to: "/dashboard" | "/overlays" | "/interact" | "/bot" | "/chat" | "/content" | "/revenue" | "/relays" | "/developer";
  current: boolean;
}

export interface FooterEntry {
  id: "transparency" | "takedown" | "dmca";
  to: "/transparency" | "/takedown" | "/dmca";
}

export interface AccountMenuOptions {
  /** Platform treasurers also get the treasury. */
  treasurer?: boolean;
  /** Platform moderators, admins and `legal` also get the mod queue. */
  safetyStaff?: boolean;
  /** The `legal` role also gets the legal queue. */
  legal?: boolean;
  /** Admins also get co-op administration (`/admin/coop`). */
  admin?: boolean;
}

export interface AdminEntry {
  id: "treasury" | "moderation" | "appeals" | "dmca" | "legal" | "coop" | "integrity" | "egress" | "incidents" | "apps";
  to:
    | "/treasury"
    | "/admin/moderation"
    | "/admin/appeals"
    | "/admin/dmca"
    | "/admin/legal"
    | "/admin/coop"
    | "/admin/integrity"
    | "/admin/egress"
    | "/admin/incidents"
    | "/admin/apps";
  current: boolean;
}

export interface AdminNavOptions {
  treasurer?: boolean;
  /** Moderators, admins and `legal`: the mod queue. */
  safetyStaff?: boolean;
  /** Moderators and admins: the appeals and DMCA queues. */
  platformModerator?: boolean;
  legal?: boolean;
  /** Admins: co-op administration (appoint workers), integrity flags, egress, incidents and OAuth apps. */
  admin?: boolean;
}

/** Trailing slashes do not change the page (`/relays/` is `/relays`). */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function siteNav(pathname: string): SiteNavEntry[] {
  const path = normalize(pathname);
  return [
    { id: "directory", to: "/", current: path === "/" },
    { id: "coop", to: "/coop", current: path === "/coop" || path.startsWith("/coop/") },
  ];
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
      ...(options.admin === true ? [{ id: "adminCoop", to: "/admin/coop" } as const] : []),
    ];
    return [
      { id: "dashboard", to: "/dashboard" },
      { id: "relays", to: "/relays" },
      { id: "subscriptions", to: "/settings/subscriptions" },
      { id: "notifications", to: "/settings/notifications" },
      { id: "appeals", to: "/settings/appeals" },
      { id: "copyright", to: "/settings/copyright" },
      { id: "privacy", to: "/settings/privacy" },
      { id: "connections", to: "/settings/connections" },
      { id: "coop", to: "/coop/membership" },
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

export interface StudioNavOptions {
  /** The instance runs the verified-watch gate or the surge guard (`features.watchGate || features.surgeGuard`). */
  chatSafety?: boolean;
}

export function studioNav(pathname: string, options: StudioNavOptions = {}): StudioEntry[] {
  const path = normalize(pathname);
  return [
    { id: "streamManager", to: "/dashboard", current: path === "/dashboard" },
    { id: "overlays", to: "/overlays", current: path === "/overlays" },
    { id: "interact", to: "/interact", current: path === "/interact" },
    { id: "bot", to: "/bot", current: path === "/bot" },
    ...(options.chatSafety === true ? [{ id: "chat", to: "/chat", current: path === "/chat" } as const] : []),
    { id: "content", to: "/content", current: path === "/content" },
    { id: "revenue", to: "/revenue", current: path === "/revenue" },
    { id: "relays", to: "/relays", current: path === "/relays" },
    { id: "developer", to: "/developer", current: path === "/developer" || path.startsWith("/developer/") },
  ];
}

/** Public pages linked from every footer. */
export function footerNav(): FooterEntry[] {
  return [
    { id: "transparency", to: "/transparency" },
    { id: "takedown", to: "/takedown" },
    { id: "dmca", to: "/dmca" },
  ];
}

/** The platform-tools sidebar: only the pages the role may open. */
export function adminNav(pathname: string, options: AdminNavOptions): AdminEntry[] {
  const path = normalize(pathname);
  const entries: Omit<AdminEntry, "current">[] = [
    ...(options.treasurer === true ? [{ id: "treasury", to: "/treasury" } as const] : []),
    ...(options.safetyStaff === true ? [{ id: "moderation", to: "/admin/moderation" } as const] : []),
    ...(options.platformModerator === true ? [{ id: "appeals", to: "/admin/appeals" } as const] : []),
    ...(options.platformModerator === true ? [{ id: "dmca", to: "/admin/dmca" } as const] : []),
    ...(options.legal === true ? [{ id: "legal", to: "/admin/legal" } as const] : []),
    ...(options.admin === true
      ? ([
          { id: "coop", to: "/admin/coop" },
          { id: "integrity", to: "/admin/integrity" },
          { id: "egress", to: "/admin/egress" },
          { id: "incidents", to: "/admin/incidents" },
          { id: "apps", to: "/admin/apps" },
        ] as const)
      : []),
  ];
  return entries.map((entry) => ({ ...entry, current: path === entry.to }));
}
