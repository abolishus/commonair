// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Timers on `/bot`: messages the bot posts every N minutes once N chat lines went by (a timer
 * never talks to an empty room). Create and edit in a dialog, remove after a confirmation.
 */
import { EmptyState, IconButton, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Clock01Icon, Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  TIMER_LIMITS,
  emptyTimerDraft,
  timerDraft,
  timerInput,
  timerSaveError,
  type BotTimerDto,
  type TimerDraft,
  type TimerField,
} from "../../lib/bot-studio.ts";
import type { FieldErrors } from "../../lib/interact-studio.ts";
import {
  ConfirmIconButton,
  StudioSection,
  TextField,
  ToggleField,
  type StudioApi,
} from "../interact-studio/shared.tsx";

type Editing = { mode: "new" } | { mode: "edit"; timer: BotTimerDto } | null;

export function TimersPanel({
  channel,
  initial,
  client,
}: {
  channel: string;
  initial: BotTimerDto[];
  client: StudioApi;
}): React.JSX.Element {
  const [timers, setTimers] = React.useState(initial);
  const [editing, setEditing] = React.useState<Editing>(null);
  const api = client.bot.timers;

  const save = async (draft: TimerDraft): Promise<FieldErrors<TimerField> | null> => {
    const checked = timerInput(channel, draft);
    if (!checked.ok) return checked.errors;
    const saved = await api.upsert(checked.input);
    setTimers((list) => [...list.filter((x) => x.id !== saved.id), saved]);
    toast.success(t("bot.timer.saved", { name: saved.name }));
    setEditing(null);
    return null;
  };

  const remove = async (timer: BotTimerDto): Promise<void> => {
    await api.remove({ channel, id: timer.id });
    setTimers((list) => list.filter((x) => x.id !== timer.id));
    toast.success(t("bot.timer.removed", { name: timer.name }));
  };

  return (
    <StudioSection
      icon={Clock01Icon}
      title={t("bot.timer.title")}
      description={t("bot.timer.intro")}
      action={
        <Button type="button" size="sm" data-testid="timer-new" onClick={() => setEditing({ mode: "new" })}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("bot.timer.new")}
        </Button>
      }
    >
      {timers.length === 0 ? (
        <EmptyState data-testid="timer-empty" icon={Clock01Icon} headingLevel={3} title={t("bot.timer.empty")} />
      ) : (
        <ul className="flex flex-col divide-y" aria-label={t("bot.timer.title")}>
          {[...timers]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((timer) => (
              <li
                key={timer.id}
                data-testid="timer-row"
                data-timer-id={timer.id}
                data-enabled={timer.enabled ? "true" : "false"}
                className="flex flex-wrap items-start gap-2 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-words">{timer.name}</span>
                    <StatusBadge tone={timer.enabled ? "success" : "neutral"}>
                      {timer.enabled ? t("bot.on") : t("bot.off")}
                    </StatusBadge>
                  </div>
                  <p className="text-xs break-words text-muted-foreground">{timer.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("bot.timer.schedule", { minutes: timer.intervalMinutes, count: timer.minChatLines })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <IconButton
                    type="button"
                    icon={PencilEdit01Icon}
                    label={t("bot.timer.edit", { name: timer.name })}
                    data-testid="timer-edit"
                    onClick={() => setEditing({ mode: "edit", timer })}
                  />
                  <ConfirmIconButton
                    icon={Delete02Icon}
                    label={t("bot.timer.remove", { name: timer.name })}
                    data-testid="timer-remove"
                    title={t("bot.timer.removeTitle", { name: timer.name })}
                    description={t("bot.timer.removeBody")}
                    confirmLabel={t("bot.timer.removeConfirm")}
                    onConfirm={() => remove(timer)}
                    onError={(err) => toastActionError(err, t("bot.timer.removeFailed"))}
                  />
                </div>
              </li>
            ))}
        </ul>
      )}
      <TimerDialog
        key={editing === null ? "closed" : editing.mode === "new" ? "new" : editing.timer.id}
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={save}
      />
    </StudioSection>
  );
}

function TimerDialog({
  editing,
  onClose,
  onSave,
}: {
  editing: Editing;
  onClose: () => void;
  onSave: (draft: TimerDraft) => Promise<FieldErrors<TimerField> | null>;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<TimerDraft>(() =>
    editing?.mode === "edit" ? timerDraft(editing.timer) : emptyTimerDraft(),
  );
  const [errors, setErrors] = React.useState<FieldErrors<TimerField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof TimerDraft>(key: K, value: TimerDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      setErrors((await onSave(draft)) ?? {});
    } catch (err) {
      setFailure(timerSaveError(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form data-testid="timer-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === "edit"
                ? t("bot.timer.editTitle", { name: editing.timer.name })
                : t("bot.timer.newTitle")}
            </DialogTitle>
            <DialogDescription>{t("bot.timer.formHint")}</DialogDescription>
          </DialogHeader>
          <TextField
            label={t("bot.timer.name")}
            value={draft.name}
            onChange={(v) => set("name", v)}
            data-testid="timer-name"
            error={errors.name}
          />
          <TextField
            label={t("bot.timer.message")}
            value={draft.message}
            onChange={(v) => set("message", v)}
            data-testid="timer-message"
            multiline
            error={errors.message}
            description={t("bot.timer.messageHint", { max: TIMER_LIMITS.messageMax })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("bot.timer.interval")}
              value={draft.interval}
              onChange={(v) => set("interval", v)}
              data-testid="timer-interval"
              numeric
              error={errors.interval}
              description={t("bot.timer.intervalHint", {
                min: TIMER_LIMITS.intervalMin,
                max: TIMER_LIMITS.intervalMax,
              })}
            />
            <TextField
              label={t("bot.timer.minLines")}
              value={draft.minLines}
              onChange={(v) => set("minLines", v)}
              data-testid="timer-min-lines"
              numeric
              error={errors.minLines}
              description={t("bot.timer.minLinesHint")}
            />
          </div>
          <ToggleField
            label={t("bot.timer.enabled")}
            checked={draft.enabled}
            onChange={(v) => set("enabled", v)}
            data-testid="timer-enabled"
          />
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("bot.cancel")}
            </Button>
            <Button type="submit" data-testid="timer-save" disabled={pending}>
              {t("bot.timer.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
