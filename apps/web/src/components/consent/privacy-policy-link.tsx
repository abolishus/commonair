// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { ScrollArea } from "@commonair/ui/components/scroll-area";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api, type Api } from "../../lib/api.ts";

type PrivacyPolicy = Awaited<ReturnType<Api["legal"]["get"]>>;
type Load = { status: "idle" | "loading" | "failed" } | { status: "ready"; doc: PrivacyPolicy };

/**
 * The banner's privacy policy link. There is no legal page route (documents open in a dialog, as
 * `LegalDocumentLink` does), and the banner shows on a visitor's first page, so the text is
 * fetched only when the link is opened, not with every first visit.
 */
export function PrivacyPolicyLink(): React.JSX.Element {
  const [load, setLoad] = React.useState<Load>({ status: "idle" });
  const fetchPolicy = React.useCallback(() => {
    setLoad({ status: "loading" });
    api()
      .legal.get({ kind: "privacy" })
      .then(
        (doc) => setLoad({ status: "ready", doc }),
        () => setLoad({ status: "failed" }),
      );
  }, []);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && load.status !== "ready" && load.status !== "loading") fetchPolicy();
      }}
    >
      <DialogTrigger
        data-testid="consent-privacy-link"
        className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("cookieBanner.privacyLink")}
      </DialogTrigger>
      <DialogContent data-testid="consent-privacy-dialog" className="max-w-2xl">
        {load.status === "ready" ? (
          <>
            <DialogHeader>
              <DialogTitle>{load.doc.title}</DialogTitle>
              <DialogDescription>
                {load.doc.isDraft
                  ? t("legal.versionDraft", { version: load.doc.version })
                  : t("legal.version", { version: load.doc.version })}
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-96">
              <div className="pe-3 text-sm whitespace-pre-wrap">{load.doc.body}</div>
            </ScrollArea>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("cookieBanner.privacyLink")}</DialogTitle>
              <DialogDescription aria-live="polite">
                {load.status === "failed" ? t("cookieBanner.privacy.failed") : t("cookieBanner.privacy.loading")}
              </DialogDescription>
            </DialogHeader>
            {load.status === "failed" ? (
              <div>
                <Button variant="outline" data-testid="consent-privacy-retry" onClick={fetchPolicy}>
                  {t("cookieBanner.privacy.retry")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
