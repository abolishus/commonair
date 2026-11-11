// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog } from "@commonair/ui";
import { CharacterCountField, FormSection, SelectField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { monthLabel } from "../../lib/money.ts";

/** The contract's cap on a month note (`transparency.setNote`). */
export const MONTH_NOTE_MAX = 2000;

export interface MonthNoteMonth {
  month: string;
  note: { body: string } | null;
}

export interface MonthNoteEditorProps {
  /** The months the page shows, newest first; the editor starts on the newest. */
  months: readonly MonthNoteMonth[];
  /** `transparency.setNote`: an empty body removes the note. */
  onSave: (month: string, body: string) => Promise<void>;
}

/**
 * The treasurer's month-note editor (overhaul D6.1), on the months the treasurer sees on
 * `/transparency`: pick a month, write or change its public note, or remove it (confirmed). Each
 * save is audited by the API. Never the brand colour: this is a staff action.
 */
export function MonthNoteEditor({ months, onSave }: MonthNoteEditorProps): React.JSX.Element {
  const [month, setMonth] = React.useState<string | null>(months[0]?.month ?? null);
  const current = months.find((m) => m.month === month) ?? null;
  const [draft, setDraft] = React.useState(current?.note?.body ?? "");
  const [pending, setPending] = React.useState(false);
  // A different month, or a saved note coming back from the reload, resets the draft to what is stored.
  const stored = current?.note?.body ?? "";
  const [shown, setShown] = React.useState({ month, stored });
  if (shown.month !== month || shown.stored !== stored) {
    setShown({ month, stored });
    setDraft(stored);
  }

  if (months.length === 0 || month === null)
    return (
      <FormSection title={t("d6Transparency.note.title")} description={t("d6Transparency.note.hint")}>
        <p className="text-sm text-muted-foreground">{t("d6Transparency.note.noMonths")}</p>
      </FormSection>
    );

  const save = async (body: string, done: string) => {
    setPending(true);
    try {
      await onSave(month, body);
      toast.success(done);
    } catch (err) {
      toastActionError(err, t("d6Transparency.note.failed"));
      throw err;
    } finally {
      setPending(false);
    }
  };
  const trimmed = draft.trim();
  const unchanged = trimmed === stored.trim();

  return (
    <FormSection
      data-testid="transparency-note-editor"
      title={t("d6Transparency.note.title")}
      description={t("d6Transparency.note.hint")}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (pending || unchanged) return;
        save(draft, trimmed === "" ? t("d6Transparency.note.removed") : t("d6Transparency.note.saved")).catch(
          () => undefined,
        );
      }}
    >
      <SelectField
        label={t("d6Transparency.note.month")}
        value={month}
        onValueChange={setMonth}
        options={months.map((m) => ({ value: m.month, label: monthLabel(m.month) }))}
        triggerProps={{ "data-testid": "transparency-note-month" }}
      />
      <CharacterCountField
        label={t("d6Transparency.note.body")}
        multiline
        maxLength={MONTH_NOTE_MAX}
        value={draft}
        onValueChange={setDraft}
        hint={t("d6Transparency.note.bodyHint")}
        textareaProps={{ "data-testid": "transparency-note-body", rows: 4 }}
      />
      <div className="flex flex-wrap gap-2">
        <Button data-testid="transparency-note-save" type="submit" disabled={pending || unchanged}>
          {t("d6Transparency.note.save")}
        </Button>
        {current?.note && (
          <ConfirmDialog
            trigger={
              <Button data-testid="transparency-note-remove" type="button" variant="outline" disabled={pending}>
                {t("d6Transparency.note.remove")}
              </Button>
            }
            title={t("d6Transparency.note.removeTitle", { month: monthLabel(month) })}
            description={t("d6Transparency.note.removeBody")}
            confirmLabel={t("d6Transparency.note.remove")}
            variant="destructive"
            onConfirm={() => save("", t("d6Transparency.note.removed"))}
            // `save` already toasted the failure; the dialog stays open for another try.
            onError={() => undefined}
            contentProps={{ "data-testid": "transparency-note-remove-dialog" }}
          />
        )}
      </div>
    </FormSection>
  );
}
