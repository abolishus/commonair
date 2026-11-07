// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LoadError } from "@commonair/ui/blocks/feedback";
import type * as React from "react";
import { loadErrorNote, loadErrorTitle, loadRetryLabel } from "./load-copy.ts";
import type { RetryStatus } from "./retrying-load.ts";

export interface SectionLoadErrorProps {
  /** The section's own heading, already translated ("Open proposals"). */
  section: string;
  /**
   * The failed load (`useRetryingLoad`), or just its Retry. `busy`: a retry is under way without
   * a known wait (the session recovery).
   */
  load: Partial<Pick<RetryStatus, "retryInMs" | "gaveUp">> & Pick<RetryStatus, "reload"> & { busy?: boolean };
  /** Nothing else on the page has data. */
  alone?: boolean;
  headingLevel?: 2 | 3 | 4;
  "data-testid"?: string;
  retryTestId?: string;
  className?: string;
}

/**
 * The one load-failure pattern (F3, voice-copy 4.10): the section that did not load plus Retry,
 * with what happens next: an automatic retry, still failing after the retries ran out, or that
 * the rest of the page is fine. The words live in `load-copy.ts`.
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
  const busy = waiting !== null || load.busy === true;
  const seconds = waiting === null ? undefined : Math.max(1, Math.ceil(waiting / 1000));
  const description = loadErrorNote(busy ? "busy" : load.gaveUp ? "stillFailing" : alone ? "page" : "section", seconds);
  return (
    <LoadError
      data-testid={testId}
      retryTestId={retryTestId}
      className={className}
      headingLevel={headingLevel}
      busy={busy}
      title={loadErrorTitle(section)}
      description={description}
      retryLabel={loadRetryLabel(busy)}
      onRetry={load.reload}
    />
  );
}
