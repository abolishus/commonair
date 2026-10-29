// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Variables on `/bot`: values commands and timers use as `${var:name}`; setting a name again replaces it. */
import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { VariableIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  VARIABLE_LIMITS,
  variableInput,
  variableSaveError,
  type BotVariableDto,
  type VariableDraft,
  type VariableField,
} from "../../lib/bot-studio.ts";
import type { FieldErrors } from "../../lib/interact-studio.ts";
import { StudioSection, TextField, type StudioApi } from "../interact-studio/shared.tsx";

export function VariablesPanel({
  channel,
  initial,
  client,
}: {
  channel: string;
  initial: BotVariableDto[];
  client: StudioApi;
}): React.JSX.Element {
  const [variables, setVariables] = React.useState(initial);
  const [draft, setDraft] = React.useState<VariableDraft>({ name: "", value: "" });
  const [errors, setErrors] = React.useState<FieldErrors<VariableField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const checked = variableInput(channel, draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
      await client.bot.variables.set(checked.input);
      const { name, value } = checked.input;
      setVariables((list) => [...list.filter((v) => v.name !== name), { name, value }]);
      setDraft({ name: "", value: "" });
      toast.success(t("bot.variable.saved", { name }));
    } catch (err) {
      setFailure(variableSaveError(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <StudioSection icon={VariableIcon} title={t("bot.variable.title")} description={t("bot.variable.intro")}>
      {variables.length === 0 ? (
        <EmptyState icon={VariableIcon} headingLevel={3} title={t("bot.variable.empty")} />
      ) : (
        <dl className="flex flex-col divide-y" aria-label={t("bot.variable.title")}>
          {[...variables]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((v) => (
              <div
                key={v.name}
                data-testid="variable-row"
                data-name={v.name}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2"
              >
                <dt className="font-mono text-xs">{v.name}</dt>
                <dd className="min-w-0 flex-1 text-sm break-words">{v.value}</dd>
              </div>
            ))}
        </dl>
      )}
      <form
        data-testid="variable-form"
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
        aria-label={t("bot.variable.formLabel")}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("bot.variable.name")}
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name }))}
            data-testid="variable-name"
            error={errors.name}
            description={t("bot.variable.nameHint", { max: VARIABLE_LIMITS.nameMax })}
          />
          <TextField
            label={t("bot.variable.value")}
            value={draft.value}
            onChange={(value) => setDraft((d) => ({ ...d, value }))}
            data-testid="variable-value"
            error={errors.value}
          />
        </div>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <Button type="submit" data-testid="variable-save" disabled={pending} className="self-start">
          {t("bot.variable.save")}
        </Button>
      </form>
    </StudioSection>
  );
}
