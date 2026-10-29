// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ConsentPrompt } from "../../lib/consent.ts";

/**
 * The consent banner: a labelled region (a `section` with a name) in the page flow at the top, never fixed and never
 * modal (it takes no focus). Its three choices have equal weight, so declining is as easy as
 * allowing. `relative z-20` keeps it above the studio sidebar, which is fixed from `md` up.
 */
export function ConsentBanner({
  reason,
  onAccept,
  onReject,
  onCustomize,
}: {
  reason: ConsentPrompt;
  onAccept: () => void;
  onReject: () => void;
  onCustomize: () => void;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="consent-banner"
      data-reason={reason}
      className="relative z-20 border-b bg-card px-4 py-3 text-card-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-sm font-medium">
            {t("consent.banner.title")}
          </h2>
          <p className="text-xs/relaxed text-muted-foreground">
            {reason === "policy-changed" ? t("consent.banner.bodyChanged") : t("consent.banner.body")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 md:shrink-0">
          <Button variant="outline" className="grow md:grow-0" data-testid="consent-accept-all" onClick={onAccept}>
            {t("consent.banner.accept")}
          </Button>
          <Button variant="outline" className="grow md:grow-0" data-testid="consent-reject" onClick={onReject}>
            {t("consent.banner.reject")}
          </Button>
          <Button variant="outline" className="grow md:grow-0" data-testid="consent-customize" onClick={onCustomize}>
            {t("consent.banner.customize")}
          </Button>
        </div>
      </div>
    </section>
  );
}
