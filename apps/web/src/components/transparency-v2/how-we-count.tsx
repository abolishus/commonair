// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Section } from "@commonair/ui/blocks/headers";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";

/** The section's anchor: the watch page's "How we count" link lands here (`#how-we-count`). */
export const HOW_WE_COUNT_ID = "how-we-count";

const PARTS: readonly { id: string; title: MessageKey; body: MessageKey }[] = [
  { id: "live", title: "d6Transparency.how.liveTitle", body: "d6Transparency.how.live" },
  { id: "settled", title: "d6Transparency.how.settledTitle", body: "d6Transparency.how.settled" },
  { id: "owner", title: "d6Transparency.how.ownerTitle", body: "d6Transparency.how.owner" },
  { id: "statements", title: "d6Transparency.how.statementsTitle", body: "d6Transparency.how.statements" },
];

/**
 * "How we count" (overhaul decision 2, round2/viewer-count.md) in plain words: the live number is
 * the worker's verified count; settled numbers come after the stream and are the only final ones;
 * what the creator's own viewing does today (stated as it is, not as planned); and audience
 * statements, with the public verifier.
 */
export function HowWeCount(): React.JSX.Element {
  return (
    <Section
      id={HOW_WE_COUNT_ID}
      data-testid="transparency-how-we-count"
      heading={t("d6Transparency.how.title")}
      description={t("d6Transparency.how.intro")}
      className="scroll-mt-20"
    >
      <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {PARTS.map((p) => (
          <div key={p.id} data-part={p.id} className="flex min-w-0 flex-col gap-1">
            <dt className="text-sm font-semibold">{t(p.title)}</dt>
            <dd className="text-sm break-words text-muted-foreground">{t(p.body)}</dd>
          </div>
        ))}
      </dl>
      <Link
        to="/attestations/verify"
        data-testid="transparency-how-verify"
        className="inline-block text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {t("d6Transparency.how.verifyLink")}
      </Link>
    </Section>
  );
}
