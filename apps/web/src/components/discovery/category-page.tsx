// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/directory/$category` (F1): the category's art, name, live channels and (when exact) viewers,
 * the tags its live channels carry, then the Live tab. Videos and Clips tabs wait on an API that
 * lists them by category (a contract request); fetching per channel is not an option.
 */
import type { Category, StreamCard } from "@commonair/contracts/dto";
import { EmptyState, formatCompactNumber, useLocale } from "@commonair/ui";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { GridViewIcon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryStats } from "../../lib/directory-sections.ts";
import { NotFoundState } from "../not-found.tsx";
import { liveLabel, viewerLabel } from "./category-tiles.tsx";
import { LiveView } from "./directory-page.tsx";
import type { Page } from "./loaders.ts";
import { CardLinks } from "./stream-cards.tsx";

export function CategoryPage({ category, live }: { category: Category; live: Page<StreamCard> }): React.JSX.Element {
  const { locale } = useLocale();
  const stats = categoryStats([category], live.items, live.nextCursor === null).get(category.id);
  return (
    <PageContainer
      width="wide"
      data-testid="category-page"
      data-category={category.slug}
      className="flex flex-col gap-6 py-6"
    >
      <header className="flex min-w-0 gap-4">
        <span className="block aspect-3/4 w-20 shrink-0 overflow-hidden bg-muted sm:w-28">
          <HeaderArt imageUrl={category.boxArtUrl} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 dir="auto" className="text-2xl font-semibold tracking-tight break-words">
            {category.name}
          </h1>
          <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
            <span>{liveLabel(formatCompactNumber(category.liveChannels, locale), category.liveChannels)}</span>
            {stats?.viewers !== undefined && (
              <span>{viewerLabel(formatCompactNumber(stats.viewers, locale), stats.viewers)}</span>
            )}
          </p>
          {stats && stats.tags.length > 0 && <CardLinks category={null} tags={stats.tags} />}
        </div>
      </header>
      <PageTabs
        aria-label={t("discovery.category.tabs")}
        value="live"
        onValueChange={() => {}}
        items={[
          {
            id: "live",
            label: t("discovery.category.tabLive"),
            "data-testid": "category-tab-live",
            content: (
              <div className="pt-4">
                <LiveView
                  initial={live}
                  category={category.slug}
                  empty={
                    <EmptyState
                      icon={LiveStreaming02Icon}
                      title={t("discovery.category.noneLive", { category: category.name })}
                      description={t("discovery.category.noneLiveHint")}
                      action={
                        <Button variant="outline" nativeButton={false} render={<Link to="/directory" />}>
                          {t("discovery.category.browseOthers")}
                        </Button>
                      }
                    />
                  }
                />
              </div>
            ),
          },
        ]}
      />
    </PageContainer>
  );
}

/**
 * The header's box art, or a neutral glyph tile without it. Interim: `CategoryArt` (the tile's
 * token-coloured fallback, F10) is not exported from `@commonair/ui/blocks/media` yet (a contract
 * request); once it is, this becomes `<CategoryArt slug imageUrl iconSize="lg" />`.
 */
function HeaderArt({ imageUrl }: { imageUrl: string | null | undefined }): React.JSX.Element {
  if (imageUrl)
    return (
      <span data-slot="category-art" className="block size-full">
        <img src={imageUrl} alt="" decoding="async" className="size-full object-cover" />
      </span>
    );
  return (
    <span data-slot="category-art" aria-hidden className="grid size-full place-items-center text-muted-foreground">
      <HugeiconsIcon icon={GridViewIcon} strokeWidth={1.5} aria-hidden className="size-10" />
    </span>
  );
}

/** An unknown category: D4's not-found state, pointing back to the directory. */
export function CategoryNotFound(): React.JSX.Element {
  return (
    <NotFoundState
      data-testid="category-not-found"
      icon={GridViewIcon}
      title={t("discovery.category.notFound")}
      description={t("discovery.category.notFoundHint")}
    />
  );
}
