// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the site chrome links to, as data: the header nav, the account menu, the phone's bottom
 * tab bar, the creator studio sidebar and the footer. `current` is derived from the pathname here
 * so the components stay router-agnostic, and so is where the tab bar shows (`shellArea`).
 */

export interface SiteNavEntry {
  id: "directory" | "coop";
  to: "/directory" | "/coop";
  current: boolean;
}

export interface AccountEntry {
  id:
    | "channel"
    | "studio"
    | "modView"
    | "following"
    | "settings"
    | "coop"
    | "treasury"
    | "moderation"
    | "legal"
    | "adminCoop"
    | "signOut";
  /** Absent for actions (sign out). */
  to?:
    | "/$channel"
    | "/dashboard"
    | "/mod/$channel"
    | "/following"
    | "/settings"
    | "/coop/membership"
    | "/treasury"
    | "/admin/moderation"
    | "/admin/legal"
    | "/admin/coop";
  /** `channel`: the member's own channel; `modView`: the first channel they moderate. */
  params?: { channel: string };
  separatorBefore?: boolean;
  destructive?: boolean;
}

/**
 * Where a page sits in the shell, from its path: `browse` pages get the phone's bottom tab bar;
 * `watch` (a channel, its videos, clips and giveaways, the mod-share view), `auth`, `settings`,
 * `studio` and `admin` pages never do, nor does any other `page` (forms such as DMCA).
 */
export type ShellArea = "browse" | "watch" | "auth" | "settings" | "studio" | "admin" | "page";

/** A section of the phone's bottom tab bar (below md, browsing pages only). */
export interface TabEntry {
  /** `following` signed in, `coop` signed out, in the third slot. */
  id: "home" | "browse" | "following" | "coop" | "you";
  /** Absent for the member's You tab, which opens the account sheet. */
  to?: "/" | "/directory" | "/following" | "/coop" | "/signin";
  current: boolean;
}

export interface SignedOutEntry {
  id: "signIn" | "signUp";
  to: "/signin" | "/signup";
  current: boolean;
}

export interface StudioEntry {
  id:
    | "streamManager"
    | "streamSettings"
    | "modView"
    | "moderated"
    | "audience"
    | "rehearse"
    | "overlays"
    | "interact"
    | "bot"
    | "chat"
    | "captions"
    | "content"
    | "analytics"
    | "schedule"
    | "revenue"
    | "crew"
    | "relays"
    | "move"
    | "import"
    | "developer";
  to:
    | "/dashboard"
    | "/dashboard/settings"
    | "/mod/$channel"
    | "/rehearse"
    | "/overlays"
    | "/interact"
    | "/bot"
    | "/chat"
    | "/captions"
    | "/content"
    | "/analytics"
    | "/schedule"
    | "/revenue"
    | "/crew"
    | "/relays"
    | "/move"
    | "/import"
    | "/developer";
  /** `modView` and `moderated`: the channel the mod view opens (the member's own, or one they moderate). */
  params?: { channel: string };
  /** `moderated` only: the channel's display name, for the label. */
  label?: string;
  current: boolean;
}

/**
 * The studio sidebar's groups (overhaul D5.8, creator-studio.md P8), in order. `moderates` is the
 * "Channels you moderate" group (ux-journeys J5-a), only for a member who holds a role elsewhere.
 */
export type StudioGroupId = "home" | "setup" | "community" | "moderates" | "content" | "money" | "grow" | "coopTools";

export interface StudioGroup {
  id: StudioGroupId;
  items: StudioEntry[];
}

/** The platform-tools sidebar's groups (F22, admin), in order. */
export type AdminGroupId = "safety" | "money" | "coop" | "platform";

export interface AdminGroup {
  id: AdminGroupId;
  items: AdminEntry[];
}

/** The co-op section's tabs (`/coop/*`, and the public transparency page). */
export interface CoopEntry {
  id: "overview" | "membership" | "proposals" | "council" | "jury" | "settings" | "patronage" | "transparency";
  to:
    | "/coop"
    | "/coop/membership"
    | "/coop/proposals"
    | "/coop/council"
    | "/coop/jury"
    | "/coop/settings"
    | "/coop/patronage"
    | "/transparency";
}

export interface FooterEntry {
  id:
    | "creators"
    | "studio"
    | "import"
    | "coopOverview"
    | "membership"
    | "proposals"
    | "transparency"
    | "attestations"
    | "takedown"
    | "dmca"
    | "terms"
    | "privacy"
    | "guidelines";
  to:
    | "/creators"
    | "/dashboard"
    | "/import"
    | "/coop"
    | "/coop/membership"
    | "/coop/proposals"
    | "/transparency"
    | "/attestations/verify"
    | "/takedown"
    | "/dmca"
    | "/terms"
    | "/privacy"
    | "/guidelines";
}

/** The footer's three link columns, in order. */
export interface FooterColumnEntry {
  id: "create" | "coop" | "legal";
  links: FooterEntry[];
}

export interface FooterOptions {
  /** Twitch import is available (`features.twitchImport`). */
  twitchImport?: boolean;
}

/** A VOD's or a clip's public watch page (W2-vod-watch), as a typed router link. */
export type WatchLink =
  | { to: "/$channel/vods/$vodId"; params: { channel: string; vodId: string } }
  | { to: "/$channel/clips/$clipId"; params: { channel: string; clipId: string } };

export interface AccountMenuOptions {
  /** The member's channel slug, for "Your channel"; without one the entry is left out. */
  channel?: string | null;
  /** Platform treasurers also get the treasury. */
  treasurer?: boolean;
  /** Platform moderators, admins and `legal` also get the mod queue. */
  safetyStaff?: boolean;
  /** The `legal` role also gets the legal queue. */
  legal?: boolean;
  /** Admins also get co-op administration (`/admin/coop`). */
  admin?: boolean;
  /** `me.moderates` slugs, live first; any (but the own channel) adds "Mod view". */
  moderates?: readonly string[];
}

export interface AdminEntry {
  id:
    | "treasury"
    | "moderation"
    | "appeals"
    | "dmca"
    | "legal"
    | "coop"
    | "integrity"
    | "egress"
    | "incidents"
    | "apps"
    | "federation"
    | "growth";
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
    | "/admin/apps"
    | "/admin/federation"
    | "/admin/growth";
  current: boolean;
}

export interface AdminNavOptions {
  treasurer?: boolean;
  /** Moderators, admins and `legal`: the mod queue. */
  safetyStaff?: boolean;
  /** Moderators and admins: the appeals and DMCA queues. */
  platformModerator?: boolean;
  legal?: boolean;
  /** Admins: co-op administration (appoint workers), integrity flags, egress, incidents, OAuth apps and federation. */
  admin?: boolean;
  /** The instance federates (`features.federation`); the admin federation page is hidden otherwise. */
  federation?: boolean;
}

/** Trailing slashes do not change the page (`/relays/` is `/relays`). */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function siteNav(pathname: string): SiteNavEntry[] {
  const path = normalize(pathname);
  return [
    // Browse is the directory (decision (a)): current there, on a category page and on search.
    {
      id: "directory",
      to: "/directory",
      current: path === "/directory" || path.startsWith("/directory/") || path === "/search",
    },
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
    // The decisions log's order: Your channel, Creator studio, Following, Settings (one entry; its
    // pages have their own nav), Co-op membership, staff tools, then (the menu adds the theme)
    // Sign out after a separator. Relays moved into the studio. "Mod view" follows the studio for
    // a member who moderates elsewhere (ux-journeys J5-a), opening the first (live-first) channel.
    const channel = options.channel ? options.channel : null;
    const modded = options.moderates?.find((slug) => slug !== channel);
    return [
      ...(channel ? [{ id: "channel", to: "/$channel", params: { channel } } as const] : []),
      { id: "studio", to: "/dashboard" },
      ...(modded ? [{ id: "modView", to: "/mod/$channel", params: { channel: modded } } as const] : []),
      { id: "following", to: "/following" },
      { id: "settings", to: "/settings" },
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
  /** Twitch import is available (`features.twitchImport`: flag on and credentials set; never under `--no-proprietary`). */
  twitchImport?: boolean;
}

export function studioNav(pathname: string, options: StudioNavOptions = {}): StudioEntry[] {
  const path = normalize(pathname);
  return [
    { id: "streamManager", to: "/dashboard", current: path === "/dashboard" },
    { id: "rehearse", to: "/rehearse", current: path === "/rehearse" },
    { id: "overlays", to: "/overlays", current: path === "/overlays" },
    { id: "interact", to: "/interact", current: path === "/interact" },
    { id: "bot", to: "/bot", current: path === "/bot" },
    ...(options.chatSafety === true ? [{ id: "chat", to: "/chat", current: path === "/chat" } as const] : []),
    { id: "captions", to: "/captions", current: path === "/captions" },
    { id: "content", to: "/content", current: path === "/content" },
    { id: "analytics", to: "/analytics", current: path === "/analytics" },
    { id: "schedule", to: "/schedule", current: path === "/schedule" },
    { id: "revenue", to: "/revenue", current: path === "/revenue" },
    { id: "crew", to: "/crew", current: path === "/crew" },
    { id: "relays", to: "/relays", current: path === "/relays" },
    { id: "move", to: "/move", current: path === "/move" },
    ...(options.twitchImport === true ? [{ id: "import", to: "/import", current: path === "/import" } as const] : []),
    { id: "developer", to: "/developer", current: path === "/developer" || path.startsWith("/developer/") },
  ];
}

/** A channel the member moderates or edits (`me.moderates`), as the nav needs it. */
export interface ModeratedNavChannel {
  slug: string;
  displayName: string;
}

export interface StudioNavGroupOptions extends StudioNavOptions {
  /** The member's own channel slug, for the mod view link (`/mod/<channel>`). */
  channel: string;
  /** `me.moderates`, in its order (live first); each gets a mod view link. The own channel is dropped. */
  moderates?: readonly ModeratedNavChannel[];
}

/** `/mod/<slug>` exactly (not `/mod` or `/mod/<slug>/more`), as the slug. */
function modViewSlug(path: string): string | null {
  const parts = path.split("/");
  return parts.length === 3 && parts[1] === "mod" && parts[2] ? parts[2] : null;
}

/**
 * The studio sidebar grouped (overhaul D5.8, creator-studio.md P8): Home (stream manager), Set up
 * (stream settings, alerts and overlays, rehearsal, captions), Community (mod view, chat safety,
 * bot, polls and raids), Channels you moderate (a mod view link each, J5-a), Content (videos and
 * clips), Money (revenue, crew), Grow (bring your audience, analytics, move, import) and Co-op &
 * tools (relays, developer). The stream manager is current only on `/dashboard` itself. "Bring
 * your audience" opens `/move` (move and follow links), the one page that always holds the
 * audience tools: the dashboard checklist shows that step only before the first stream, while
 * offline and for some sign-ups, so an anchor there would often land nowhere. "Move channel"
 * stays the entry marked current on `/move`. A moderated channel's link is current on
 * its `/mod/<channel>`; any other `/mod/<x>` marks the own mod view current.
 */
export function studioNavGroups(pathname: string, options: StudioNavGroupOptions): StudioGroup[] {
  const path = normalize(pathname);
  const flat = new Map(studioNav(pathname, options).map((entry) => [entry.id, entry]));
  const pick = (...ids: StudioEntry["id"][]): StudioEntry[] =>
    ids.flatMap((id) => {
      const entry = flat.get(id);
      return entry ? [entry] : [];
    });
  const streamSettings: StudioEntry = {
    id: "streamSettings",
    to: "/dashboard/settings",
    current: path === "/dashboard/settings",
  };
  const moderated = (options.moderates ?? []).filter((m) => m.slug !== options.channel);
  const modSlug = modViewSlug(path);
  const onModerated = modSlug !== null && moderated.some((m) => m.slug === modSlug);
  const modView: StudioEntry = {
    id: "modView",
    to: "/mod/$channel",
    params: { channel: options.channel },
    current: modSlug !== null && !onModerated,
  };
  const audience: StudioEntry = { id: "audience", to: "/move", current: false };
  const groups: StudioGroup[] = [
    { id: "home", items: pick("streamManager") },
    { id: "setup", items: [streamSettings, ...pick("overlays", "rehearse", "captions")] },
    { id: "community", items: [modView, ...pick("chat", "bot", "interact")] },
    {
      id: "moderates",
      items: moderated.map((m) => ({
        id: "moderated",
        to: "/mod/$channel",
        params: { channel: m.slug },
        label: m.displayName,
        current: modSlug === m.slug,
      })),
    },
    { id: "content", items: pick("content") },
    { id: "money", items: pick("revenue", "crew") },
    { id: "grow", items: [audience, ...pick("analytics", "schedule", "move", "import")] },
    { id: "coopTools", items: pick("relays", "developer") },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/**
 * The platform-tools sidebar grouped (F22): Safety (the queues), Money (the treasury), Co-op and
 * Platform. Only the pages the role may open; a group with none is left out.
 */
export function adminNavGroups(pathname: string, options: AdminNavOptions): AdminGroup[] {
  const entries = new Map(adminNav(pathname, options).map((entry) => [entry.id, entry]));
  const pick = (...ids: AdminEntry["id"][]): AdminEntry[] =>
    ids.flatMap((id) => {
      const entry = entries.get(id);
      return entry ? [entry] : [];
    });
  const groups: AdminGroup[] = [
    { id: "safety", items: pick("moderation", "appeals", "dmca", "legal") },
    { id: "money", items: pick("treasury") },
    { id: "coop", items: pick("coop") },
    { id: "platform", items: pick("integrity", "egress", "incidents", "growth", "apps", "federation") },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** The co-op section's tabs, in order (the jury sits beside the council: ADR 0038). */
export function coopNav(): CoopEntry[] {
  return [
    { id: "overview", to: "/coop" },
    { id: "membership", to: "/coop/membership" },
    { id: "proposals", to: "/coop/proposals" },
    { id: "council", to: "/coop/council" },
    { id: "jury", to: "/coop/jury" },
    { id: "settings", to: "/coop/settings" },
    { id: "patronage", to: "/coop/patronage" },
    { id: "transparency", to: "/transparency" },
  ];
}

/**
 * The footer's columns: Create (the creators pitch, the studio, Twitch import where offered),
 * Co-op (how it works, membership, proposals, transparency) and Legal (the terms, privacy policy
 * and community guidelines, then copyright, intimate-image takedown and the viewer count proof
 * verifier).
 */
export function footerColumns(options: FooterOptions = {}): FooterColumnEntry[] {
  return [
    {
      id: "create",
      links: [
        { id: "creators", to: "/creators" },
        { id: "studio", to: "/dashboard" },
        ...(options.twitchImport === true ? [{ id: "import", to: "/import" } as const] : []),
      ],
    },
    {
      id: "coop",
      links: [
        { id: "coopOverview", to: "/coop" },
        { id: "membership", to: "/coop/membership" },
        { id: "proposals", to: "/coop/proposals" },
        { id: "transparency", to: "/transparency" },
      ],
    },
    {
      id: "legal",
      links: [
        { id: "terms", to: "/terms" },
        { id: "privacy", to: "/privacy" },
        { id: "guidelines", to: "/guidelines" },
        { id: "dmca", to: "/dmca" },
        { id: "takedown", to: "/takedown" },
        { id: "attestations", to: "/attestations/verify" },
      ],
    },
  ];
}

/** Static first segments that are not a channel name (`/<channel>` is a watch page). */
const BROWSE_ROOTS = new Set(["directory", "search", "following", "coop", "transparency", "creators"]);
const AUTH_ROOTS = new Set(["signin", "signup", "activate", "oauth2"]);
const STUDIO_ROOTS = new Set([
  "dashboard",
  "rehearse",
  "overlays",
  "interact",
  "bot",
  "chat",
  "captions",
  "content",
  "analytics",
  "revenue",
  "crew",
  "relays",
  "move",
  "import",
  "developer",
  "mod",
]);
const ADMIN_ROOTS = new Set(["admin", "treasury"]);
const PAGE_ROOTS = new Set(["dmca", "takedown", "attestations", "embed", "overlay", "terms", "privacy", "guidelines"]);
/** A channel's sub-pages that are watch pages too. */
const WATCH_CHILDREN = new Set(["vods", "clips", "giveaways"]);

export function shellArea(pathname: string): ShellArea {
  const path = normalize(pathname);
  if (path === "/") return "browse";
  const [root = "", ...rest] = path.slice(1).split("/");
  if (BROWSE_ROOTS.has(root)) return "browse";
  if (AUTH_ROOTS.has(root)) return "auth";
  if (root === "settings") return "settings";
  if (STUDIO_ROOTS.has(root)) return "studio";
  if (ADMIN_ROOTS.has(root)) return "admin";
  if (PAGE_ROOTS.has(root)) return "page";
  // The mod-share view (`/m/<channel>/<nonce>`) watches a channel too.
  if (root === "m") return "watch";
  if (rest.length === 0) return "watch";
  if (WATCH_CHILDREN.has(rest[0] ?? "")) return "watch";
  return "page";
}

/** The bottom tab bar shows on browsing pages only (below md; the component hides it from md). */
export function tabBarVisible(pathname: string): boolean {
  return shellArea(pathname) === "browse";
}

/**
 * The bottom tab bar's sections: Home, Browse, then Following (signed in) or Co-op (signed out),
 * then You, which is Sign in for a visitor (below md Sign in leaves the header for it).
 */
export function tabBarNav(pathname: string, signedIn: boolean): TabEntry[] {
  const path = normalize(pathname);
  const under = (root: string) => path === root || path.startsWith(`${root}/`);
  return [
    { id: "home", to: "/", current: path === "/" },
    { id: "browse", to: "/directory", current: under("/directory") || path === "/search" },
    signedIn
      ? { id: "following", to: "/following", current: under("/following") }
      : { id: "coop", to: "/coop", current: under("/coop") },
    signedIn ? { id: "you", current: false } : { id: "you", to: "/signin", current: path === "/signin" },
  ];
}

/** The watch page of a channel's VOD. */
export function vodWatchLink(channel: string, vodId: string): WatchLink {
  return { to: "/$channel/vods/$vodId", params: { channel, vodId } };
}

/** The watch page of a channel's clip. */
export function clipWatchLink(channel: string, clipId: string): WatchLink {
  return { to: "/$channel/clips/$clipId", params: { channel, clipId } };
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
          { id: "growth", to: "/admin/growth" },
          { id: "apps", to: "/admin/apps" },
        ] as const)
      : []),
    ...(options.admin === true && options.federation === true
      ? [{ id: "federation", to: "/admin/federation" } as const]
      : []),
  ];
  return entries.map((entry) => ({ ...entry, current: path === entry.to }));
}
