// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goals on `/interact` (docs/testing/e8-selectors.md "Goals"): the open and recently ended goals
 * with their progress, and for the owner and editors the form and an end control. A tips target
 * is typed in the currency's major units and sent in minor units.
 */
import { ConfirmDialog, EmptyState, MoneyAmount, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { SelectField } from "@commonair/ui/blocks/forms";
import { ProgressRow } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Target02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import {
  GOAL_LIMITS,
  emptyGoalDraft,
  goalInput,
  goalPercent,
  goalTypeLabel,
  isGoalType,
  orderedGoals,
  type FieldErrors,
  type GoalDraft,
  type GoalDto,
  type GoalField,
} from "../../lib/interact-studio.ts";
import { StudioSection, TextField, fillNodes, useLiveState, usePolling, type StudioApi } from "./shared.tsx";

/** Goals move with follows, subscriptions and tips; a slower refresh is enough. */
export const GOAL_REFRESH_MS = 5000;

export function GoalPanel({
  channel,
  initial,
  client,
  currency,
  canManage,
  refreshMs = GOAL_REFRESH_MS,
}: {
  channel: string;
  initial: GoalDto[];
  client: StudioApi;
  currency: string;
  canManage: boolean;
  refreshMs?: number;
}): React.JSX.Element {
  const [goals, setGoals, refreshGoals] = useLiveState(initial);
  const goalsApi = client.interact.goals;
  usePolling(
    goals.some((g) => g.endedAt === null),
    refreshMs,
    () => refreshGoals(() => goalsApi.list({ channel })),
  );
  const ordered = orderedGoals(goals);

  return (
    <StudioSection icon={Target02Icon} title={t("interact.goal.title")} description={t("interact.goal.intro")}>
      {ordered.length === 0 ? (
        <EmptyState
          icon={Target02Icon}
          headingLevel={3}
          title={t("interact.goal.empty")}
          description={canManage ? t("interact.goal.emptyHint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-4" aria-label={t("interact.goal.listLabel")}>
          {ordered.map((g) => (
            <GoalRow
              key={g.id}
              goal={g}
              currency={currency}
              canManage={canManage}
              onEnd={async () => {
                const ended = await goalsApi.end({ channel, id: g.id });
                setGoals((list) => list.map((x) => (x.id === ended.id ? ended : x)));
                toast.success(t("interact.goal.ended"));
              }}
            />
          ))}
        </ul>
      )}
      {canManage ? (
        <GoalForm
          currency={currency}
          onStart={async (draft, locale) => {
            const checked = goalInput(channel, draft, currency, locale);
            if (!checked.ok) return checked.errors;
            const created = await goalsApi.create(checked.input);
            setGoals((list) => [created, ...list]);
            toast.success(t("interact.goal.started"));
            return null;
          }}
        />
      ) : null}
    </StudioSection>
  );
}

function GoalAmount({ goal, value, currency }: { goal: GoalDto; value: number; currency: string }) {
  const { locale } = useLocale();
  if (goal.type === "tips") return <MoneyAmount value={{ cents: value, currency }} />;
  return <>{formatNumber(value, locale)}</>;
}

function GoalRow({
  goal,
  currency,
  canManage,
  onEnd,
}: {
  goal: GoalDto;
  currency: string;
  canManage: boolean;
  onEnd: () => Promise<void>;
}): React.JSX.Element {
  const ended = goal.endedAt !== null;
  return (
    <li
      data-testid="goal-row"
      data-goal-id={goal.id}
      data-type={goal.type}
      data-current={goal.current}
      data-target={goal.target}
      data-ended={ended ? "true" : "false"}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{goal.title}</span>
        <StatusBadge tone="neutral">{goalTypeLabel(goal.type)}</StatusBadge>
        {ended ? (
          <StatusBadge tone={goal.current >= goal.target ? "success" : "neutral"}>
            {goal.current >= goal.target ? t("interact.goal.achieved") : t("interact.goal.endedBadge")}
          </StatusBadge>
        ) : null}
      </div>
      <ProgressRow
        label={t("interact.goal.progress")}
        value={goalPercent(goal)}
        tone={goal.current >= goal.target ? "success" : "default"}
        valueText={
          <>
            {fillNodes(t("interact.goal.progressValue"), {
              current: <GoalAmount goal={goal} value={goal.current} currency={currency} />,
              target: <GoalAmount goal={goal} value={goal.target} currency={currency} />,
            })}
          </>
        }
      />
      {canManage && !ended ? (
        <ConfirmDialog
          trigger={
            <Button type="button" size="sm" variant="outline" className="self-start" data-testid="goal-end">
              {t("interact.goal.end")}
            </Button>
          }
          title={t("interact.goal.endTitle", { title: goal.title })}
          description={t("interact.goal.endBody")}
          confirmLabel={t("interact.goal.end")}
          onConfirm={onEnd}
          onError={(err) => toastActionError(err, t("interact.goal.endFailed"))}
        />
      ) : null}
    </li>
  );
}

type StartGoal = (draft: GoalDraft, locale: string) => Promise<FieldErrors<GoalField> | null>;

export function GoalForm({ currency, onStart }: { currency: string; onStart: StartGoal }): React.JSX.Element {
  const { locale } = useLocale();
  const [draft, setDraft] = React.useState<GoalDraft>(emptyGoalDraft);
  const [errors, setErrors] = React.useState<FieldErrors<GoalField>>({});
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const result = await onStart(draft, locale);
      if (result) setErrors(result);
      else {
        setErrors({});
        setDraft(emptyGoalDraft());
      }
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("interact.goal.error.busy"));
      else toastActionError(err, t("interact.goal.startFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="goal-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4 border-t pt-4"
      aria-label={t("interact.goal.formLabel")}
    >
      <SelectField
        label={t("interact.goal.type")}
        value={draft.type}
        triggerProps={{ "data-testid": "goal-type" }}
        options={[
          { value: "followers", label: goalTypeLabel("followers"), "data-testid": "goal-type-followers" },
          { value: "subscriptions", label: goalTypeLabel("subscriptions"), "data-testid": "goal-type-subscriptions" },
          { value: "tips", label: goalTypeLabel("tips"), "data-testid": "goal-type-tips" },
        ]}
        onValueChange={(value) => {
          if (isGoalType(value)) setDraft((d) => ({ ...d, type: value }));
        }}
      />
      <TextField
        label={t("interact.goal.name")}
        value={draft.title}
        onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
        data-testid="goal-title"
        error={errors.title}
        description={t("interact.goal.nameHint", { max: GOAL_LIMITS.titleMax })}
      />
      <TextField
        label={draft.type === "tips" ? t("interact.goal.targetAmount", { currency }) : t("interact.goal.target")}
        value={draft.target}
        onChange={(v) => setDraft((d) => ({ ...d, target: v }))}
        data-testid="goal-target"
        numeric={draft.type !== "tips"}
        decimal={draft.type === "tips"}
        error={errors.target}
        description={draft.type === "tips" ? t("interact.goal.targetAmountHint") : undefined}
      />
      <Button type="submit" data-testid="goal-start" disabled={pending} className="self-start">
        {t("interact.goal.start")}
      </Button>
    </form>
  );
}
