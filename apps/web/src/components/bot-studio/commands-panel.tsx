// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Custom commands on `/bot` (docs/testing/e8-selectors.md "Channel bot"): the table, create and
 * edit in a dialog, remove after a confirmation, and the template variables a response can use
 * (docs/streamers/channel-bot.md).
 */
import { EmptyState, IconButton, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { SelectField } from "@commonair/ui/blocks/forms";
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
import { Add01Icon, CommandLineIcon, Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { USER_LEVELS } from "@commonair/contracts/enums";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  BOT_TEMPLATE_VARIABLES,
  COMMAND_LIMITS,
  commandDraft,
  commandInput,
  commandSaveError,
  emptyCommandDraft,
  isUserLevel,
  userLevelLabel,
  type BotCommandDto,
  type CommandDraft,
  type CommandField,
} from "../../lib/bot-studio.ts";
import type { FieldErrors } from "../../lib/interact-studio.ts";
import {
  ConfirmIconButton,
  StudioSection,
  TextField,
  ToggleField,
  type StudioApi,
} from "../interact-studio/shared.tsx";

type Editing = { mode: "new" } | { mode: "edit"; command: BotCommandDto } | null;

export function CommandsPanel({
  channel,
  initial,
  client,
  canEdit,
}: {
  channel: string;
  initial: BotCommandDto[];
  client: StudioApi;
  canEdit: boolean;
}): React.JSX.Element {
  const [commands, setCommands] = React.useState(initial);
  const [editing, setEditing] = React.useState<Editing>(null);
  const { locale } = useLocale();
  const api = client.bot.commands;
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));

  const save = async (draft: CommandDraft): Promise<FieldErrors<CommandField> | null> => {
    const taken = editing?.mode === "new" ? commands.map((c) => c.name) : [];
    const checked = commandInput(channel, draft, taken);
    if (!checked.ok) return checked.errors;
    const saved = await api.upsert(checked.input);
    setCommands((list) => [...list.filter((c) => c.name !== saved.name), saved]);
    toast.success(t("bot.command.saved", { name: saved.name }));
    setEditing(null);
    return null;
  };

  const remove = async (name: string): Promise<void> => {
    await api.remove({ channel, name });
    setCommands((list) => list.filter((c) => c.name !== name));
    toast.success(t("bot.command.removed", { name }));
  };

  const columns: DataTableColumn<BotCommandDto>[] = [
    {
      id: "name",
      header: t("bot.command.name"),
      cell: ({ row: { original: c } }) => (
        <span className="font-mono">
          !{c.name}
          {c.aliases.length > 0 ? (
            <span className="block text-muted-foreground">{c.aliases.map((a) => `!${a}`).join(", ")}</span>
          ) : null}
        </span>
      ),
    },
    { id: "level", header: t("bot.command.level"), cell: ({ row: { original: c } }) => userLevelLabel(c.userLevel) },
    {
      id: "cooldown",
      align: "numeric",
      header: t("bot.command.cooldown"),
      cell: ({ row: { original: c } }) => t("bot.command.seconds", { count: c.cooldownSeconds }),
    },
    {
      id: "cost",
      align: "numeric",
      header: t("bot.command.cost"),
      cell: ({ row: { original: c } }) => formatNumber(c.costPoints, locale),
    },
    {
      id: "uses",
      align: "numeric",
      header: t("bot.command.uses"),
      cell: ({ row: { original: c } }) => formatNumber(c.useCount, locale),
    },
    {
      id: "status",
      header: t("bot.command.status"),
      cell: ({ row: { original: c } }) => (
        <StatusBadge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? t("bot.on") : t("bot.off")}</StatusBadge>
      ),
    },
  ];
  if (canEdit)
    columns.push({
      id: "actions",
      header: t("bot.command.actions"),
      cell: ({ row: { original: c } }) => (
        <div className="flex justify-end gap-1">
          <IconButton
            type="button"
            icon={PencilEdit01Icon}
            label={t("bot.command.edit", { name: c.name })}
            data-testid="command-edit"
            onClick={() => setEditing({ mode: "edit", command: c })}
          />
          <ConfirmIconButton
            icon={Delete02Icon}
            label={t("bot.command.remove", { name: c.name })}
            data-testid="command-remove"
            title={t("bot.command.removeTitle", { name: c.name })}
            description={t("bot.command.removeBody")}
            confirmLabel={t("bot.command.removeConfirm")}
            onConfirm={() => remove(c.name)}
            onError={(err) => toastActionError(err, t("bot.command.removeFailed"))}
          />
        </div>
      ),
    });

  return (
    <StudioSection
      icon={CommandLineIcon}
      title={t("bot.command.title")}
      description={t("bot.command.intro")}
      action={
        canEdit ? (
          <Button type="button" size="sm" data-testid="command-new" onClick={() => setEditing({ mode: "new" })}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("bot.command.new")}
          </Button>
        ) : undefined
      }
    >
      <DataTable
        caption={t("bot.command.title")}
        columns={columns}
        rows={sorted}
        getRowId={(c) => c.name}
        rowProps={(c) => ({
          "data-testid": "command-row",
          "data-name": c.name,
          "data-uses": c.useCount,
          "data-enabled": c.enabled ? "true" : "false",
          "data-cost": c.costPoints,
        })}
        empty={
          <EmptyState
            data-testid="command-empty"
            icon={CommandLineIcon}
            headingLevel={3}
            title={t("bot.command.empty")}
            description={canEdit ? t("bot.command.emptyHint") : undefined}
          />
        }
      />
      <TemplateHelp />
      {canEdit ? (
        <CommandDialog
          key={editing === null ? "closed" : editing.mode === "new" ? "new" : editing.command.name}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </StudioSection>
  );
}

/** The variables a response can use. The tokens are syntax (never translated); what they become is. */
function TemplateHelp(): React.JSX.Element {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium">{t("bot.variables.help.title")}</summary>
      <dl className="mt-2 flex flex-col gap-1">
        {BOT_TEMPLATE_VARIABLES.map((v) => (
          <div key={v.token} className="flex flex-wrap gap-x-3">
            <dt className="font-mono">{v.token}</dt>
            <dd className="text-muted-foreground">{t(v.key)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function CommandDialog({
  editing,
  onClose,
  onSave,
}: {
  editing: Editing;
  onClose: () => void;
  onSave: (draft: CommandDraft) => Promise<FieldErrors<CommandField> | null>;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<CommandDraft>(() =>
    editing?.mode === "edit" ? commandDraft(editing.command) : emptyCommandDraft(),
  );
  const [errors, setErrors] = React.useState<FieldErrors<CommandField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof CommandDraft>(key: K, value: CommandDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await onSave(draft);
      setErrors(result ?? {});
    } catch (err) {
      setFailure(commandSaveError(err));
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
        <form data-testid="command-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === "edit"
                ? t("bot.command.editTitle", { name: editing.command.name })
                : t("bot.command.newTitle")}
            </DialogTitle>
            <DialogDescription>{t("bot.command.formHint")}</DialogDescription>
          </DialogHeader>
          <TextField
            label={t("bot.command.name")}
            value={draft.name}
            onChange={(v) => set("name", v)}
            data-testid="command-name"
            error={errors.name}
            disabled={editing?.mode === "edit"}
            description={t("bot.command.nameHint", { max: COMMAND_LIMITS.nameMax })}
          />
          <TextField
            label={t("bot.command.aliases")}
            value={draft.aliases}
            onChange={(v) => set("aliases", v)}
            data-testid="command-aliases"
            error={errors.aliases}
            description={t("bot.command.aliasesHint", { max: COMMAND_LIMITS.aliasesMax })}
          />
          <TextField
            label={t("bot.command.response")}
            value={draft.response}
            onChange={(v) => set("response", v)}
            data-testid="command-response"
            multiline
            error={errors.response}
            description={t("bot.command.responseHint", { max: COMMAND_LIMITS.responseMax })}
          />
          <SelectField
            label={t("bot.command.level")}
            value={draft.level}
            triggerProps={{ "data-testid": "command-level" }}
            options={USER_LEVELS.map((level) => ({
              value: level,
              label: userLevelLabel(level),
              "data-testid": `command-level-${level}`,
            }))}
            onValueChange={(value) => {
              if (isUserLevel(value)) set("level", value);
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("bot.command.cooldownField")}
              value={draft.cooldown}
              onChange={(v) => set("cooldown", v)}
              data-testid="command-cooldown"
              numeric
              error={errors.cooldown}
              description={t("bot.command.cooldownHint", { max: COMMAND_LIMITS.cooldownMax })}
            />
            <TextField
              label={t("bot.command.costField")}
              value={draft.cost}
              onChange={(v) => set("cost", v)}
              data-testid="command-cost"
              numeric
              error={errors.cost}
              description={t("bot.command.costHint")}
            />
          </div>
          <ToggleField
            label={t("bot.command.enabled")}
            checked={draft.enabled}
            onChange={(v) => set("enabled", v)}
            data-testid="command-enabled"
          />
          {failure ? (
            <p data-testid="command-error" role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("bot.cancel")}
            </Button>
            <Button type="submit" data-testid="command-save" disabled={pending}>
              {t("bot.command.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
