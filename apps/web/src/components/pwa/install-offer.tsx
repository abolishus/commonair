// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { consentPrompt, useConsent } from "../../lib/consent.ts";
import { shellArea, tabBarVisible } from "../../lib/nav.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { closeIosSteps, dismissInstallOffer, requestInstall, startInstallWatch, useInstall } from "./install-store.ts";

/** "Install" from a menu or the offer: the browser's dialog, or Apple's steps; a toast once installed. */
export function installApp(site: string): void {
  void requestInstall(() => toast.success(t("d7Pwa.install.accepted", { site })));
}

/**
 * Where the offer in context may show: browse pages only (home, directory, following, search), so
 * never over a player (watch pages and the studio have one) and never on forms or settings.
 */
export function offerAllowedOn(pathname: string): boolean {
  return shellArea(pathname) === "browse";
}

/**
 * The offer in context: a small dismissible card in the bottom corner (above the phone's tab
 * bar), non-modal and announced politely. One "Install" (not the brand fill: the page keeps its
 * own call to action) and "Not now", which is remembered for good.
 */
export function InstallOfferCard({
  site,
  aboveTabBar,
  onInstall,
  onDismiss,
}: {
  site: string;
  aboveTabBar: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const titleId = React.useId();
  React.useEffect(() => {
    trackUi("pwa.install", "view");
  }, []);
  return (
    <section
      aria-labelledby={titleId}
      aria-live="polite"
      data-testid="pwa-install-offer"
      className={`fixed inset-x-4 z-40 flex flex-col gap-3 border bg-popover p-4 text-sm text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 md:inset-x-auto md:end-6 md:bottom-6 md:w-96 md:max-w-viewport-6 ${aboveTabBar ? "bottom-safe-tab-bar" : "bottom-safe-gutter"}`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-medium">
          {t("d7Pwa.install.offer.title", { site })}
        </h2>
        <p className="text-muted-foreground">{t("d7Pwa.install.offer.body")}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" data-testid="pwa-install-offer-dismiss" onClick={onDismiss}>
          {t("d7Pwa.install.offer.dismiss")}
        </Button>
        <Button data-testid="pwa-install-offer-install" onClick={onInstall}>
          {t("d7Pwa.install.offer.install")}
        </Button>
      </div>
    </section>
  );
}

/** Apple's mobile WebKit has no install dialog: the Add to Home Screen steps instead. */
export function IosInstallDialog({
  site,
  open,
  onOpenChange,
}: {
  site: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent data-testid="pwa-install-ios">
        <DialogHeader>
          <DialogTitle>{t("d7Pwa.install.ios.title", { site })}</DialogTitle>
          <DialogDescription>{t("d7Pwa.install.ios.intro")}</DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 ps-5">
          <li>{t("d7Pwa.install.ios.step1")}</li>
          <li>{t("d7Pwa.install.ios.step2")}</li>
          <li>{t("d7Pwa.install.ios.step3")}</li>
        </ol>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" data-testid="pwa-install-ios-done" />}>
            {t("d7Pwa.install.ios.done")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** True while the cookie banner asks (or may ask): the offer waits rather than stack on it. */
function useConsentBannerPending(): boolean {
  const consent = useConsent();
  if (!consent.ready) return true;
  return consentPrompt(consent.stored, consent.policy?.version ?? null) !== null;
}

/**
 * Mounted once by the PWA root (never on overlays or embeds): starts the install watch after
 * hydration, shows the offer in context when it is due on a browse page, and the iOS steps when
 * a menu or the offer asked for them.
 */
export function InstallRoot({ pathname, site }: { pathname: string; site: string }): React.JSX.Element {
  const install = useInstall();
  const consentPending = useConsentBannerPending();
  React.useEffect(() => startInstallWatch(), []);
  const showOffer = install.offerDue && install.mode !== "none" && offerAllowedOn(pathname) && !consentPending;
  return (
    <>
      {showOffer ? (
        <InstallOfferCard
          site={site}
          aboveTabBar={tabBarVisible(pathname)}
          onInstall={() => installApp(site)}
          onDismiss={() => dismissInstallOffer()}
        />
      ) : null}
      <IosInstallDialog
        site={site}
        open={install.iosOpen}
        onOpenChange={(open) => {
          if (!open) closeIosSteps();
        }}
      />
    </>
  );
}
