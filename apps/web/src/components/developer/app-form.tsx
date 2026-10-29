// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `devapp-form`: register an app or edit one. Redirect URIs are checked here with the API's own
 * rule (`redirectUriProblem`); whatever the API still refuses is shown inline.
 */
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { TextField, ToggleField } from "../interact-studio/shared.tsx";
import type { OAuthAppDto } from "./client.ts";
import { APP_LIMITS, type AppDraft, type AppField, type FieldErrors, appDraft, emptyAppDraft } from "./model.ts";

export type AppEditing = { mode: "new" } | { mode: "edit"; app: OAuthAppDto } | null;

/** What a save answers: field errors to show, or null when it went through (the dialog closes). */
export type AppSave = (draft: AppDraft) => Promise<FieldErrors<AppField> | null>;

export function AppFormDialog({
  editing,
  onClose,
  onSave,
  errorMessage,
}: {
  editing: AppEditing;
  onClose: () => void;
  onSave: AppSave;
  /** The inline message for a refused save. */
  errorMessage: (err: unknown) => string;
}): React.JSX.Element {
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {editing ? (
          <AppForm
            key={editing.mode === "edit" ? editing.app.id : "new"}
            editing={editing}
            onClose={onClose}
            onSave={onSave}
            errorMessage={errorMessage}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AppForm({
  editing,
  onClose,
  onSave,
  errorMessage,
}: {
  editing: NonNullable<AppEditing>;
  onClose: () => void;
  onSave: AppSave;
  errorMessage: (err: unknown) => string;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<AppDraft>(() =>
    editing.mode === "edit" ? appDraft(editing.app) : emptyAppDraft(),
  );
  const [errors, setErrors] = React.useState<FieldErrors<AppField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof AppDraft>(key: K, value: AppDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      setErrors((await onSave(draft)) ?? {});
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form data-testid="devapp-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {editing.mode === "edit"
            ? t("developer.app.editTitle", { name: editing.app.name })
            : t("developer.app.newTitle")}
        </DialogTitle>
        <DialogDescription>{t("developer.app.formHint")}</DialogDescription>
      </DialogHeader>
      <TextField
        label={t("developer.app.name")}
        value={draft.name}
        onChange={(v) => set("name", v)}
        data-testid="devapp-name"
        error={errors.name}
      />
      <TextField
        label={t("developer.app.description")}
        value={draft.description}
        onChange={(v) => set("description", v)}
        data-testid="devapp-description"
        multiline
        error={errors.description}
        description={t("developer.app.descriptionHint", { max: APP_LIMITS.descriptionMax })}
      />
      <TextField
        label={t("developer.app.redirects")}
        value={draft.redirects}
        onChange={(v) => set("redirects", v)}
        data-testid="devapp-redirects"
        multiline
        error={errors.redirects}
        description={t("developer.app.redirectsHint", { max: APP_LIMITS.redirectUrisMax })}
      />
      <ToggleField
        label={t("developer.app.confidential")}
        description={
          editing.mode === "edit" ? t("developer.app.confidentialFixed") : t("developer.app.confidentialHint")
        }
        checked={draft.confidential}
        onChange={(v) => set("confidential", v)}
        disabled={editing.mode === "edit"}
        data-testid="devapp-confidential"
      />
      {failure ? (
        <p role="alert" data-testid="devapp-form-error" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {t("developer.cancel")}
        </Button>
        <Button type="submit" data-testid="devapp-submit" disabled={pending}>
          {editing.mode === "edit" ? t("developer.app.save") : t("developer.app.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
