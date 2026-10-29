// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  consentPrompt,
  dismissConsentError,
  initConsent,
  isConsentFreePath,
  openCookieSettings,
  saveConsent,
  useConsent,
  type ConsentErrorCode,
  type StoredConsent,
} from "../../lib/consent.ts";
import { ConsentBanner } from "./consent-banner.tsx";
import { CookieSettingsDialog } from "./cookie-settings-dialog.tsx";

const ERROR_MESSAGE: Record<ConsentErrorCode, MessageKey> = {
  network: "consent.error.network",
  rate_limited: "consent.error.rateLimited",
  policy_changed: "consent.error.policyChanged",
  unrecorded: "consent.error.unrecorded",
  rejected: "consent.error.rejected",
};

function ConsentError({ code }: { code: ConsentErrorCode }): React.JSX.Element {
  return (
    <section
      aria-live="polite"
      data-testid="consent-error"
      data-code={code}
      className="relative z-20 flex flex-wrap items-center justify-between gap-2 border-b bg-muted px-4 py-2 text-xs text-foreground"
    >
      <p className="min-w-0">{t(ERROR_MESSAGE[code])}</p>
      <Button variant="ghost" size="sm" onClick={() => dismissConsentError()}>
        {t("consent.error.dismiss")}
      </Button>
    </section>
  );
}

function choose(preferences: boolean): void {
  // Confirm only a recorded choice: a failure shows its own notice instead.
  void saveConsent({ preferences }).then((error) => {
    if (error === null) toast.success(t("consent.toast.saved"));
  });
}

/**
 * Mounted once in the root: the save-failure notice and the banner in the page flow above every
 * shell, and the cookie settings dialog. Until the client has read its cookie it renders from
 * `Bootstrap.consent`, so the server's HTML and the first client render agree. Nothing on
 * `/overlay/*` or `/embed/*`.
 */
export function ConsentRoot({
  consent,
  signedIn,
  pathname,
}: {
  consent: StoredConsent | null;
  signedIn: boolean;
  pathname: string;
}): React.JSX.Element | null {
  const state = useConsent();
  const excluded = isConsentFreePath(pathname);
  React.useEffect(() => {
    if (!excluded) void initConsent({ signedIn });
  }, [excluded, signedIn]);
  if (excluded) return null;

  const stored = state.ready ? state.stored : consent;
  const prompt = consentPrompt(stored, state.policy?.version ?? null);
  return (
    <>
      {state.error ? <ConsentError code={state.error} /> : null}
      {prompt ? (
        <ConsentBanner
          reason={prompt}
          onAccept={() => choose(true)}
          onReject={() => choose(false)}
          onCustomize={() => openCookieSettings()}
        />
      ) : null}
      <CookieSettingsDialog onSave={choose} />
    </>
  );
}
