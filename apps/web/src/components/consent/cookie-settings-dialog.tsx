// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Switch } from "@commonair/ui/components/switch";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { closeCookieSettings, useConsent, type ConsentCategory } from "../../lib/consent.ts";
import { LegalDocumentLink } from "../legal-document-link.tsx";

function CategoryRow({
  category,
  title,
  description,
  checked,
  locked,
  children,
}: {
  category: ConsentCategory;
  title: string;
  description: string;
  checked: boolean;
  locked: boolean;
  children: (ids: { titleId: string; descriptionId: string }) => React.ReactNode;
}): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();
  return (
    <li
      data-testid="consent-category"
      data-category={category}
      data-checked={String(checked)}
      data-locked={String(locked)}
      className="flex items-start justify-between gap-3 border p-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p id={titleId} className="font-medium">
          {title}
        </p>
        <p id={descriptionId} className="text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="pt-0.5">{children({ titleId, descriptionId })}</div>
    </li>
  );
}

/**
 * Cookie settings: one row per category (essential locked on), the Preferences switch, the
 * policy text and Save. Escape and the close button leave without saving.
 */
export function CookieSettingsDialog({ onSave }: { onSave: (preferences: boolean) => void }): React.JSX.Element {
  const consent = useConsent();
  // The switch shows the stored choice until the visitor flips it; closing forgets the draft.
  const [draft, setDraft] = React.useState<boolean | null>(null);
  const preferences = draft ?? consent.stored?.preferences ?? false;
  const policy = consent.policy;

  return (
    <Dialog
      open={consent.dialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          setDraft(null);
          closeCookieSettings();
        }
      }}
    >
      <DialogContent
        data-testid="consent-dialog"
        data-policy-version={policy?.version ?? ""}
        className="max-h-dvh overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t("consent.dialog.title")}</DialogTitle>
          <DialogDescription>{t("consent.dialog.description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          <CategoryRow
            category="essential"
            title={t("consent.category.essential.title")}
            description={t("consent.category.essential.description")}
            checked
            locked
          >
            {() => (
              <span className="whitespace-nowrap text-muted-foreground">{t("consent.category.essential.state")}</span>
            )}
          </CategoryRow>
          <CategoryRow
            category="preferences"
            title={t("consent.category.preferences.title")}
            description={t("consent.category.preferences.description")}
            checked={preferences}
            locked={false}
          >
            {({ titleId, descriptionId }) => (
              <Switch
                data-testid="consent-toggle-preferences"
                checked={preferences}
                onCheckedChange={(checked) => setDraft(checked)}
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
              />
            )}
          </CategoryRow>
        </ul>
        <p className="text-muted-foreground">
          {t("consent.dialog.policy")}{" "}
          <span data-testid="consent-policy-link">
            {policy ? <LegalDocumentLink doc={policy} /> : t("consent.dialog.policyLoading")}
          </span>
        </p>
        <DialogFooter>
          <Button
            data-testid="consent-save"
            onClick={() => {
              setDraft(null);
              onSave(preferences);
            }}
          >
            {t("consent.dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
