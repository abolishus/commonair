// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton } from "@commonair/ui";
import { CategoryGrid } from "@commonair/ui/blocks/media";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { liveLabel, viewerLabel } from "./category-tiles.tsx";

/** The directory and category pages while their first data loads: the layout, not a spinner. */
export function DiscoveryPending(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-6 py-6" aria-busy>
      <span className="sr-only">{t("discovery.directory.loading")}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <CategoryGrid
        categories={[]}
        loading
        loadingCount={12}
        columns={6}
        liveLabel={liveLabel}
        viewerLabel={viewerLabel}
      />
    </PageContainer>
  );
}
