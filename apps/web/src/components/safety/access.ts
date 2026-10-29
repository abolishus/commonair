// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who sees which trust & safety page. The web only uses roles to decide what to render; the API
 * enforces access on every call (`safety-staff`, `platform-moderator`, `legal`). T0 material is
 * the `legal` role's alone: anyone else gets the not-found page for `/admin/legal`.
 */
import { notFound } from "@tanstack/react-router";
import { isTreasurer } from "../../lib/money.ts";

type MaybeUser = object | null | undefined;

function roleOf(me: MaybeUser): string | null {
  return me !== null && me !== undefined && "role" in me && typeof me.role === "string" ? me.role : null;
}

/** Platform moderators, admins and `legal`: the mod queue and NCII requests. */
export function isSafetyStaff(me: MaybeUser): boolean {
  const role = roleOf(me);
  return role === "moderator" || role === "admin" || role === "legal";
}

/** Platform moderators and admins: reports and the appeals queue (`legal` does not imply moderator). */
export function isPlatformModerator(me: MaybeUser): boolean {
  const role = roleOf(me);
  return role === "moderator" || role === "admin";
}

/** The only role that sees T0 cases, evidence, NCMEC drafts and holds. */
export function isLegal(me: MaybeUser): boolean {
  return roleOf(me) === "legal";
}

export type AdminPage =
  | "treasury"
  | "moderation"
  | "appeals"
  | "legal"
  | "coop"
  | "dmca"
  | "egress"
  | "incidents"
  | "integrity"
  | "apps";

/** Which platform-tools page a path is (`null` for anything else). Trailing slashes do not matter. */
export function adminPageFor(pathname: string): AdminPage | null {
  switch (pathname.replace(/\/+$/, "")) {
    case "/treasury":
      return "treasury";
    case "/admin/moderation":
      return "moderation";
    case "/admin/appeals":
      return "appeals";
    case "/admin/legal":
      return "legal";
    case "/admin/coop":
      return "coop";
    case "/admin/dmca":
      return "dmca";
    case "/admin/egress":
      return "egress";
    case "/admin/incidents":
      return "incidents";
    case "/admin/integrity":
      return "integrity";
    case "/admin/apps":
      return "apps";
    default:
      return null;
  }
}

export function mayOpenAdminPage(page: AdminPage | null, me: MaybeUser): boolean {
  switch (page) {
    case "treasury":
      return isTreasurer(me);
    case "moderation":
      return isSafetyStaff(me);
    case "appeals":
      return isPlatformModerator(me);
    case "legal":
      return isLegal(me);
    // Co-op administration (appointing workers): admins only.
    case "coop":
      return roleOf(me) === "admin";
    // The DMCA queue: platform moderators and admins.
    case "dmca":
      return isPlatformModerator(me);
    // Integrity flags, egress, status-page incidents and OAuth apps: admins only.
    case "egress":
    case "incidents":
    case "integrity":
    case "apps":
      return roleOf(me) === "admin";
    case null:
      return false;
  }
}

/**
 * Route guard for the platform tools: resolves the session (on the server during SSR) and answers
 * anyone without the page's role, signed out included, with the not-found page.
 */
export async function requireAdminPage<T extends object>(
  pathname: string,
  load: () => Promise<T | null>,
): Promise<{ me: T }> {
  const me = await load();
  if (me === null || !mayOpenAdminPage(adminPageFor(pathname), me)) throw notFound();
  return { me };
}
