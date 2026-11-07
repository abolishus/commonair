// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { CoopTabs, type CoopTab } from "./nav.tsx";
import type { CoopLoadsStatus, CoopRetryable } from "./use-coop.ts";

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

/**
 * One section's failed load (F3), in place of the section's content: "{section} didn't load."
 * with Retry, and "Retrying in N seconds" while a busy API is retried by itself. Keeps the
 * `coop-load-error` and `coop-retry` test ids.
 */
export function CoopSectionError({
  section,
  load,
  alone,
  headingLevel = 3,
}: {
  /** The section's own heading ("Open proposals"). */
  section: string;
  load: CoopRetryable;
  /** Nothing else on the page has data. */
  alone?: boolean;
  headingLevel?: 2 | 3 | 4;
}): React.JSX.Element {
  return (
    <SectionLoadError
      data-testid="coop-load-error"
      retryTestId="coop-retry"
      section={section}
      load={{ retryInMs: load.retryInMs ?? null, gaveUp: load.gaveUp ?? false, reload: load.reload }}
      alone={alone}
      headingLevel={headingLevel}
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
 * with the retry block above it when a reload failed, else the page. Pages whose sections fail on
 * their own (`/coop`, `/coop/council`, `/coop/settings`) use `CoopSectionError` instead.
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
