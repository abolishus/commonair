// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { cn } from "@commonair/ui/lib/utils";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ConsentPrompt } from "../../lib/consent.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { placementClasses, type BannerLayout } from "./banner-placement.ts";
import { PrivacyPolicyLink } from "./privacy-policy-link.tsx";

// Accept and Decline are the same button: same variant, size and width. Neither is the brand
// fill. Labels may wrap (Spanish runs long), and below `md` they are 40 px touch targets.
const CHOICE = "h-auto min-h-8 w-full py-1.5 whitespace-normal max-md:min-h-10";

/**
 * The consent banner (overhaul wave 2): a labelled region on the raised surface, floating in the
 * bottom corner or, on pages with a player, in the page flow (`banner-placement.ts`). It is never
 * modal: no scroll lock, no focus taken on load. It comes first in the DOM, so Tab reaches it
 * first; Escape while it has focus (or while nothing has focus) hides it for this page view and
 * records no choice.
 */
export function ConsentBanner({
  reason,
  layout,
  onAccept,
  onReject,
  onCustomize,
  onDismiss,
}: {
  reason: ConsentPrompt;
  layout: BannerLayout;
  onAccept: () => void;
  onReject: () => void;
  onCustomize: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const headingId = React.useId();
  const ref = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    trackUi("consent.banner", "view");
  }, []);

  const dismiss = React.useCallback(() => {
    const hadFocus = ref.current?.contains(document.activeElement) ?? false;
    trackUi("consent.banner", "dismiss");
    onDismiss();
    // The focused button is about to go: hand focus to the page, not to the void.
    if (hadFocus) document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
  }, [onDismiss]);

  React.useEffect(() => {
    // Escape inside the banner (in the DOM: the privacy dialog is portaled out, so its Escape is
    // its own), or with nothing focused. Anywhere else it belongs to whatever holds focus.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const inside = target instanceof Node && (ref.current?.contains(target) ?? false);
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const floating = layout.placement === "floating";
  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-testid="consent-banner"
      data-reason={reason}
      data-placement={layout.placement}
      data-above-tab-bar={String(layout.aboveTabBar)}
      className={cn(
        placementClasses(layout),
        "flex flex-col gap-3 border bg-popover p-4 text-popover-foreground shadow-raised",
        floating
          ? "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
          : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={headingId} className="text-sm font-medium">
          {t("consent.banner.title")}
        </h2>
        <p className="text-xs/relaxed text-muted-foreground">
          {reason === "policy-changed" ? t("consent.banner.bodyChanged") : t("consent.banner.body")}
        </p>
        <p className="text-xs text-muted-foreground">
          <PrivacyPolicyLink />
        </p>
      </div>
      <div className={cn("grid grid-cols-1 gap-2", floating ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
        <Button
          variant="outline"
          className={CHOICE}
          data-testid="consent-accept-all"
          data-choice-weight="equal"
          onClick={() => {
            trackUi("consent.banner", "click", "accept");
            onAccept();
          }}
        >
          {t("cookieBanner.accept")}
        </Button>
        <Button
          variant="outline"
          className={CHOICE}
          data-testid="consent-reject"
          data-choice-weight="equal"
          onClick={() => {
            trackUi("consent.banner", "click", "decline");
            onReject();
          }}
        >
          {t("cookieBanner.decline")}
        </Button>
        <Button
          variant="ghost"
          className={cn(CHOICE, floating && "sm:col-span-2")}
          data-testid="consent-customize"
          aria-haspopup="dialog"
          onClick={() => {
            trackUi("consent.banner", "click", "choose");
            onCustomize();
          }}
        >
          {t("cookieBanner.choose")}
        </Button>
      </div>
    </section>
  );
}
