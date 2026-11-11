// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Section } from "@commonair/ui/blocks/headers";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";

/**
 * The co-op's commitments (coop-trust P3, after the Mastodon Server Covenant). Only what holds
 * today (README "Positioning"): no "highest share", no "no thresholds", no share-of-surplus promise.
 */
export const COMMITMENTS: readonly { id: string; key: MessageKey }[] = [
  { id: "cut", key: "d6Transparency.commitments.cut" },
  { id: "books", key: "d6Transparency.commitments.books" },
  { id: "trackers", key: "d6Transparency.commitments.trackers" },
  { id: "source", key: "d6Transparency.commitments.source" },
];

export function Commitments(): React.JSX.Element {
  return (
    <Section heading={t("d6Transparency.commitments.title")} data-testid="transparency-commitments">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {COMMITMENTS.map((c) => (
          <li key={c.id} data-commitment={c.id} className="flex min-w-0 items-start gap-2 text-sm">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <span className="break-words">{t(c.key)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
