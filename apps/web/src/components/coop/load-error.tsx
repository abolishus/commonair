// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { CoopTabs, type CoopTab } from "./nav.tsx";
import type { CoopLoadsStatus } from "./use-coop.ts";

/** `coop-load-error`: a co-op load failed; `coop-retry` runs it again in place. */
export function CoopLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <AlertCallout
      data-testid="coop-load-error"
      tone="danger"
      live
      title={t("coop.loadFailedTitle")}
      description={t("coop.loadFailed")}
      action={
        <Button data-testid="coop-retry" variant="outline" size="sm" onClick={onRetry}>
          {t("coop.retry")}
        </Button>
      }
    />
  );
}

/** A whole co-op page whose load failed: the section tabs stay, the content is the retry block. */
export function CoopLoadFailedPage({ tab, onRetry }: { tab: CoopTab | null; onRetry: () => void }): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("coop.title")} tabs={<CoopTabs current={tab} />} />
      <CoopLoadError onRetry={onRetry} />
    </PageContainer>
  );
}

/**
 * The page when its loads allow it: the retry page when something has nothing to show, the page
 * with the retry block above it when a reload failed, else the page.
 */
export function CoopLoadGate({
  status,
  tab,
  children,
}: {
  status: CoopLoadsStatus;
  tab: CoopTab | null;
  children: React.ReactNode;
}): React.JSX.Element {
  if (status.failed) return <CoopLoadFailedPage tab={tab} onRetry={status.retry} />;
  return (
    <>
      {status.stale && (
        <PageContainer width="wide" className="pt-4">
          <CoopLoadError onRetry={status.retry} />
        </PageContainer>
      )}
      {children}
    </>
  );
}
