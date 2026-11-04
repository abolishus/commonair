// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Search in the header (F1): a field from `md` up and an icon button that opens a sheet below it,
 * both submitting to `/search`; ⌘K / Ctrl-K opens the command palette with this tab's recent
 * searches, the channels live now and their categories.
 */
import { CommandPalette, keyLabel, usePlatform, type CommandPaletteGroup } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@commonair/ui/components/input-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@commonair/ui/components/sheet";
import { HeaderSearch } from "@commonair/ui/layouts";
import { Clock01Icon, GridViewIcon, LiveStreaming02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { railSections } from "../../lib/directory-sections.ts";
import { useHomeFeed } from "./feed.ts";
import { QUERY_MAX } from "./search-params.ts";
import { readRecentSearches, rememberSearch } from "./tab-storage.ts";

/** Goes to `/search?q=`; a blank query does nothing. Returns whether it navigated. */
export function useSubmitSearch(): (query: string) => boolean {
  const navigate = useNavigate();
  return React.useCallback(
    (query: string) => {
      const q = query.trim().slice(0, QUERY_MAX);
      if (q === "") return false;
      rememberSearch(q);
      void navigate({ to: "/search", search: { q } });
      return true;
    },
    [navigate],
  );
}

/** The value of the first input in a submitted form (`HeaderSearch` owns its input). */
function submittedQuery(form: HTMLFormElement): string {
  return form.querySelector("input")?.value ?? "";
}

/** The `md`+ header field. */
export function HeaderSearchField(): React.JSX.Element {
  const submit = useSubmitSearch();
  const platform = usePlatform();
  return (
    <HeaderSearch
      data-testid="header-search"
      className="w-56 lg:w-80"
      label={t("discovery.search.label")}
      placeholder={t("discovery.search.placeholder")}
      shortcut={[keyLabel("mod", platform), keyLabel("k", platform)].join(platform === "mac" ? "" : " ")}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (submit(submittedQuery(form))) form.reset();
      }}
    />
  );
}

/** Below `md`: the header's search button opens this sheet from the top. */
export function MobileSearchSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const submit = useSubmitSearch();
  const [value, setValue] = React.useState("");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="top" data-testid="mobile-search-sheet" className="md:hidden">
        <SheetHeader>
          <SheetTitle>{t("discovery.search.label")}</SheetTitle>
        </SheetHeader>
        <search aria-label={t("discovery.search.label")} className="px-4 pb-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (submit(value)) {
                setValue("");
                onOpenChange(false);
              }
            }}
          >
            <InputGroup className="flex-1">
              <InputGroupAddon>
                <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={t("discovery.search.label")}
                placeholder={t("discovery.search.placeholder")}
                maxLength={QUERY_MAX}
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            </InputGroup>
            <Button type="submit">{t("discovery.search.submit")}</Button>
          </form>
        </search>
      </SheetContent>
    </Sheet>
  );
}

/** Live channels and categories offered by the palette (it filters what it is given). */
const PALETTE_LIMIT = 8;

/** The ⌘K palette: recent searches (this tab only), channels live now, and their categories. */
export function DiscoveryPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const submit = useSubmitSearch();
  const feed = useHomeFeed();
  // Read when it opens, so a search made a moment ago is there.
  const recent = React.useMemo(() => (open ? readRecentSearches() : []), [open]);

  const groups = React.useMemo<CommandPaletteGroup[]>(() => {
    const live = feed.home ? (railSections(feed.home, false)[0]?.entries ?? []) : [];
    const categories = new Map<string, { slug: string; name: string }>();
    for (const entry of live)
      if (entry.kind === "live" && entry.card.broadcast.category)
        categories.set(entry.card.broadcast.category.id, entry.card.broadcast.category);
    return [
      {
        id: "recent",
        label: t("discovery.palette.recent"),
        items: recent.map((q) => ({
          id: `recent:${q}`,
          label: q,
          icon: Clock01Icon,
          onSelect: () => void submit(q),
        })),
      },
      {
        id: "live",
        label: t("discovery.palette.live"),
        items: live.slice(0, PALETTE_LIMIT).map((entry) => ({
          id: `live:${entry.card.channel.slug}`,
          label: entry.card.channel.displayName,
          keywords: [entry.card.channel.slug],
          icon: LiveStreaming02Icon,
          onSelect: () => void navigate({ to: "/$channel", params: { channel: entry.card.channel.slug } }),
        })),
      },
      {
        id: "categories",
        label: t("discovery.palette.categories"),
        items: [...categories.values()].slice(0, PALETTE_LIMIT).map((category) => ({
          id: `category:${category.slug}`,
          label: category.name,
          keywords: [category.slug],
          icon: GridViewIcon,
          onSelect: () => void navigate({ to: "/directory/$category", params: { category: category.slug } }),
        })),
      },
      {
        id: "go",
        label: t("discovery.palette.go"),
        items: [
          {
            id: "go:directory",
            label: t("discovery.palette.browse"),
            icon: GridViewIcon,
            onSelect: () => void navigate({ to: "/directory" }),
          },
          {
            id: "go:search",
            label: t("discovery.palette.search"),
            icon: Search01Icon,
            onSelect: () => void navigate({ to: "/search" }),
          },
        ],
      },
    ];
  }, [feed.home, recent, navigate, submit]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      hotkey="k"
      placeholder={t("discovery.palette.placeholder")}
    />
  );
}
