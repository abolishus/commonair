// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LoadError } from "@commonair/ui/blocks/feedback";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import type { RetryStatus } from "./retrying-load.ts";

export interface SectionLoadErrorProps {
  /** The section's own heading, already translated ("Open proposals"). */
  section: string;
  /** The failed load (`useRetryingLoad`), or just its Retry. */
  load: Partial<Pick<RetryStatus, "retryInMs" | "gaveUp">> & Pick<RetryStatus, "reload">;
  /** Nothing else on the page has data: "Check your connection, then retry." */
  alone?: boolean;
  headingLevel?: 2 | 3 | 4;
  "data-testid"?: string;
  retryTestId?: string;
  className?: string;
}

/**
 * The one load-failure pattern (F3, voice-copy 4.10): "{section} didn't load." plus Retry, with
 * what happens next: an automatic retry in N seconds, still failing after the retries ran out, or
 * that the rest of the page is fine.
 */
export function SectionLoadError({
  section,
  load,
  alone = false,
  headingLevel,
  "data-testid": testId,
  retryTestId,
  className,
}: SectionLoadErrorProps): React.JSX.Element {
  const waiting = load.retryInMs ?? null;
  const description =
    waiting !== null
      ? t("fixSession.load.busy", { seconds: Math.max(1, Math.ceil(waiting / 1000)) })
      : load.gaveUp
        ? t("fixSession.load.stillFailing")
        : alone
          ? t("fixSession.load.pageBody")
          : t("fixSession.load.sectionBody");
  return (
    <LoadError
      data-testid={testId}
      retryTestId={retryTestId}
      className={className}
      headingLevel={headingLevel}
      busy={waiting !== null}
      title={t("fixSession.load.title", { section })}
      description={description}
      retryLabel={waiting !== null ? t("fixSession.retryNow") : t("fixSession.retry")}
      onRetry={load.reload}
    />
  );
}
