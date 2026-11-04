// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The left rail (F7) and its mobile twin in the header's sheet (F18). Signed out it lists the
 * channels live now; signed in, the channels the viewer follows, live first. From `lg` it is
 * expanded, on `md` it collapses to avatars, and below `md` its sections live in the sheet. The
 * viewer's own collapse choice is remembered for the tab (`tab-storage.ts`).
 */
import type { ChannelCard, StreamCard } from "@commonair/contracts/dto";
import { ChannelAvatar, IconButton, LiveBadge, RelativeTime, Skeleton, ViewerCount } from "@commonair/ui";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@commonair/ui/components/sidebar";
import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { categoryLink } from "../../lib/category-route.ts";
import {
  collidingNames,
  displayLabel,
  railSections,
  type RailEntry,
  type RailSection,
} from "../../lib/directory-sections.ts";
import { useHomeFeed } from "./feed.ts";
import { RAIL_KEY, readRail, writeTab } from "./tab-storage.ts";

/** Expanded by default from here (Tailwind's `lg`); collapsed to avatars below it. */
export const RAIL_EXPANDED_QUERY = "(min-width: 1024px)";

function sectionLabel(id: RailSection["id"]): string {
  return id === "followed" ? t("discovery.rail.followed") : t("discovery.rail.liveNow");
}

function entryChannel(entry: RailEntry): StreamCard["channel"] {
  return entry.card.channel;
}

function entryCategory(entry: RailEntry): string | null {
  return (entry.kind === "live" ? entry.card.broadcast.category?.name : entry.card.category?.name) ?? null;
}

/** The rail's sections from the shared feed, with the names that need a `@handle`. */
function useRail(): { status: "loading" | "ready" | "error"; sections: RailSection[]; collisions: Set<string> } {
  const { me } = useBootstrap();
  const feed = useHomeFeed();
  return React.useMemo(() => {
    const sections = feed.home ? railSections(feed.home, me !== null) : [];
    const collisions = collidingNames(sections.flatMap((s) => s.entries.map(entryChannel)));
    return { status: feed.status, sections, collisions };
  }, [feed, me]);
}

/**
 * Follows the screen (`lg` and up expanded) until the viewer changes it, then keeps their choice
 * for the tab. "The viewer" is any change this hook did not make itself: the toggle button, or
 * SidebarProvider's own ⌘B / Ctrl-B. Storage that throws just means the choice is not remembered.
 */
function useRailOpenState(): { open: boolean; toggle: () => void } {
  const { open, setOpen } = useSidebar();
  const setOpenRef = React.useRef(setOpen);
  const openRef = React.useRef(open);
  const auto = React.useRef(true);
  // The value this hook last asked for, until the provider reports it back.
  const applied = React.useRef<boolean | null>(null);
  const seen = React.useRef(open);
  React.useEffect(() => {
    setOpenRef.current = setOpen;
    openRef.current = open;
  });

  React.useEffect(() => {
    if (open === seen.current) return;
    seen.current = open;
    const ours = open === applied.current;
    applied.current = null;
    if (ours) return;
    auto.current = false;
    writeTab(RAIL_KEY, open ? "expanded" : "collapsed");
  }, [open]);

  React.useEffect(() => {
    const apply = (next: boolean) => {
      if (next === openRef.current) return;
      applied.current = next;
      setOpenRef.current(next);
    };
    const stored = readRail();
    if (stored) {
      auto.current = false;
      apply(stored === "expanded");
      return;
    }
    const mql = typeof window.matchMedia === "function" ? window.matchMedia(RAIL_EXPANDED_QUERY) : null;
    if (!mql) return;
    const sync = () => {
      if (auto.current) apply(mql.matches);
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  // A viewer's change: the effect on `open` above stores it and stops following the screen.
  const toggle = React.useCallback(() => setOpenRef.current(!openRef.current), []);
  return { open, toggle };
}

/** The rail inside AppShell's sidebar (`sidebarPlacement="below"`); needs its `SidebarProvider`. */
export function SideRail(): React.JSX.Element {
  const { status, sections, collisions } = useRail();
  const { open, toggle } = useRailOpenState();
  return (
    <nav
      aria-label={t("discovery.rail.label")}
      data-testid="side-rail"
      data-state={open ? "expanded" : "collapsed"}
      className="flex min-w-0 flex-col"
    >
      <div className={open ? "flex items-center justify-end p-2" : "flex items-center justify-center p-2"}>
        <IconButton
          data-testid="side-rail-toggle"
          variant="ghost"
          size="icon-sm"
          icon={SidebarLeftIcon}
          label={open ? t("discovery.rail.collapse") : t("discovery.rail.expand")}
          aria-expanded={open}
          tooltipSide="inline-end"
          onClick={toggle}
          className="rtl:-scale-x-100"
        />
      </div>
      {status === "loading" ? (
        <RailSkeleton open={open} />
      ) : status === "error" ? (
        <p className={open ? "px-4 text-xs text-muted-foreground" : "sr-only"}>{t("discovery.rail.loadFailed")}</p>
      ) : sections.length === 0 ? (
        <p className={open ? "px-4 text-xs text-muted-foreground" : "sr-only"}>{t("discovery.rail.empty")}</p>
      ) : (
        sections.map((section) => (
          <SidebarGroup key={section.id} data-section={section.id}>
            <SidebarGroupLabel>{sectionLabel(section.id)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.entries.map((entry) => (
                  <SidebarMenuItem
                    key={entry.card.channel.id}
                    data-testid="side-rail-item"
                    data-channel={entry.card.channel.slug}
                    data-live={entry.kind === "live" ? "true" : "false"}
                  >
                    <SidebarMenuButton
                      size="lg"
                      tooltip={displayLabel(collisions, entry.card.channel)}
                      render={<Link to="/$channel" params={{ channel: entry.card.channel.slug }} />}
                    >
                      <RailRowContent entry={entry} collisions={collisions} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))
      )}
    </nav>
  );
}

function RailSkeleton({ open }: { open: boolean }): React.JSX.Element {
  return (
    <div aria-hidden className="flex flex-col gap-3 p-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          {open && <Skeleton className="h-3 flex-1" />}
        </div>
      ))}
    </div>
  );
}

/** Avatar, name and category, then live state: `<LiveBadge>` + `<ViewerCount>`, or when it was last live. */
function RailRowContent({ entry, collisions }: { entry: RailEntry; collisions: Set<string> }): React.JSX.Element {
  const channel = entry.card.channel;
  const category = entryCategory(entry);
  return (
    <>
      <ChannelAvatar
        name={channel.displayName}
        src={channel.avatarUrl}
        accent={channel.accent}
        live={entry.kind === "live"}
        size="sm"
        decorative
        className="shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className="truncate text-sm font-medium">
          {displayLabel(collisions, channel)}
        </span>
        {category && (
          <span dir="auto" className="truncate text-xs text-muted-foreground">
            {category}
          </span>
        )}
      </span>
      <RailState entry={entry} />
    </>
  );
}

function RailState({ entry }: { entry: RailEntry }): React.JSX.Element {
  if (entry.kind === "live")
    return (
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <LiveBadge size="sm" />
        <ViewerCount count={entry.card.broadcast.viewerCount} size="sm" />
      </span>
    );
  return <OfflineState card={entry.card} />;
}

function OfflineState({ card }: { card: ChannelCard }): React.JSX.Element {
  return (
    <span className="shrink-0 text-2xs text-muted-foreground">
      {card.lastLiveAt ? <RelativeTime date={card.lastLiveAt} tooltip={false} /> : t("discovery.rail.offline")}
    </span>
  );
}

/** Categories with a channel live in the feed, busiest first: the sheet's Categories links. */
function liveCategories(home: { live: StreamCard[]; spotlight: StreamCard[]; newAndLive: StreamCard[] }) {
  const counts = new Map<string, { slug: string; name: string; n: number }>();
  const seen = new Set<string>();
  for (const card of [...home.spotlight, ...home.newAndLive, ...home.live]) {
    const category = card.broadcast.category;
    if (!category || seen.has(card.channel.id)) continue;
    seen.add(card.channel.id);
    const entry = counts.get(category.id) ?? { slug: category.slug, name: category.name, n: 0 };
    entry.n++;
    counts.set(category.id, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8);
}

/** Rows in the sheet's Live now (the sheet is short; the full list is on `/directory`). */
const SHEET_LIVE_LIMIT = 5;

/**
 * The mobile sheet's discovery part (F18): Following (signed in), Live now and Categories, as
 * plain links (the sheet is outside the rail's `SidebarProvider` on some pages).
 */
export function SheetDiscovery(): React.JSX.Element | null {
  const { me } = useBootstrap();
  const feed = useHomeFeed();
  if (!feed.home) return null;
  const signedIn = me !== null;
  const followed = signedIn ? railSections(feed.home, true).find((s) => s.id === "followed") : undefined;
  const live = railSections(feed.home, false)
    .find((s) => s.id === "live")
    ?.entries.filter((e) => !followed?.entries.some((f) => f.card.channel.id === e.card.channel.id))
    .slice(0, SHEET_LIVE_LIMIT);
  const categories = liveCategories(feed.home);
  const all = [...(followed?.entries ?? []), ...(live ?? [])];
  const collisions = collidingNames(all.map(entryChannel));
  return (
    <div data-testid="sheet-discovery" className="flex w-full flex-col gap-4">
      {followed && (
        <SheetGroup label={t("discovery.rail.followed")} entries={followed.entries} collisions={collisions} />
      )}
      {live && live.length > 0 && (
        <SheetGroup label={t("discovery.rail.liveNow")} entries={live} collisions={collisions} />
      )}
      {categories.length > 0 && (
        <section aria-label={t("discovery.sheet.categories")} className="flex flex-col gap-1">
          <h2 className="px-2 text-xs text-muted-foreground">{t("discovery.sheet.categories")}</h2>
          <ul className="flex flex-col">
            {categories.map((category) => (
              <li key={category.slug}>
                <Link
                  {...categoryLink(category.slug)}
                  className="flex min-h-10 items-center rounded-none px-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span dir="auto" className="truncate">
                    {category.name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SheetGroup({
  label,
  entries,
  collisions,
}: {
  label: string;
  entries: RailEntry[];
  collisions: Set<string>;
}): React.JSX.Element {
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h2 className="px-2 text-xs text-muted-foreground">{label}</h2>
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <li key={entry.card.channel.id} data-testid="sheet-rail-item" data-channel={entry.card.channel.slug}>
            <Link
              to="/$channel"
              params={{ channel: entry.card.channel.slug }}
              className="flex min-h-12 items-center gap-2 rounded-none px-2 py-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RailRowContent entry={entry} collisions={collisions} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
