// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Predictions on `/interact` (docs/testing/e8-selectors.md "Predictions"): the form while none is
 * open, the live card (refreshed every 2 s while open), lock, resolve per outcome and cancel (each
 * confirmed), then the payouts per outcome.
 */
import { ConfirmDialog, IconButton, RelativeTime, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { TallyList } from "@commonair/ui/blocks/interact-studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Award01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";
import { fillNode } from "../../lib/fill.tsx";
import {
  PREDICTION_LIMITS,
  canStartPrediction,
  emptyPredictionDraft,
  isPredictionOpen,
  predictionInput,
  predictionPayouts,
  predictionPool,
  predictionStatusLabel,
  type FieldErrors,
  type OutcomePayout,
  type PredictionDraft,
  type PredictionDto,
  type PredictionField,
} from "../../lib/interact-studio.ts";
import { POLL_REFRESH_MS } from "./poll-panel.tsx";
import { StudioSection, TextField, useLiveState, usePolling, type StudioApi } from "./shared.tsx";

type Action = { kind: "lock" } | { kind: "cancel" } | { kind: "resolve"; outcomeId: string };

export function PredictionPanel({
  channel,
  initial,
  client,
  refreshMs = POLL_REFRESH_MS,
}: {
  channel: string;
  initial: PredictionDto | null;
  client: StudioApi;
  refreshMs?: number;
}): React.JSX.Element {
  const [prediction, setPrediction, refreshPrediction] = useLiveState(initial);
  usePolling(prediction !== null && isPredictionOpen(prediction), refreshMs, () =>
    refreshPrediction(() => client.interact.predictions.current({ channel })),
  );

  const act = async (action: Action): Promise<void> => {
    if (!prediction) return;
    const p = client.interact.predictions;
    const id = prediction.id;
    const next =
      action.kind === "lock"
        ? await p.lock({ id })
        : action.kind === "cancel"
          ? await p.cancel({ id })
          : await p.resolve({ id, winningOutcomeId: action.outcomeId });
    setPrediction(next);
    toast.success(
      action.kind === "lock"
        ? t("interact.prediction.locked")
        : action.kind === "cancel"
          ? t("interact.prediction.canceled")
          : t("interact.prediction.resolved"),
    );
  };

  return (
    <StudioSection
      icon={Award01Icon}
      title={t("interact.prediction.title")}
      description={t("interact.prediction.intro")}
    >
      {prediction ? <PredictionLive prediction={prediction} onAction={act} /> : null}
      {canStartPrediction(prediction) ? (
        <PredictionForm
          onStart={async (draft) => {
            const checked = predictionInput(channel, draft);
            if (!checked.ok) return checked.errors;
            setPrediction(await client.interact.predictions.create(checked.input));
            toast.success(t("interact.prediction.started"));
            return null;
          }}
        />
      ) : null}
    </StudioSection>
  );
}

function payoutNote(payout: OutcomePayout | undefined, users: number, locale: string): string | undefined {
  if (!payout) return undefined;
  const points = formatNumber(payout.paid, locale);
  if (payout.result === "won") return t("interact.prediction.payout.won", { points, count: users });
  if (payout.result === "refunded") return t("interact.prediction.payout.refunded", { points });
  return t("interact.prediction.payout.lost");
}

function PredictionLive({
  prediction: p,
  onAction,
}: {
  prediction: PredictionDto;
  onAction: (a: Action) => Promise<void>;
}): React.JSX.Element {
  const { locale } = useLocale();
  const payouts = predictionPayouts(p);
  const onError = (err: unknown) => toastActionError(err, t("interact.prediction.actionFailed"));
  return (
    <div
      data-testid="prediction-live"
      data-prediction-id={p.id}
      data-status={p.status}
      data-locks-at={p.locksAt}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium break-words">{p.title}</h3>
        <StatusBadge tone={isPredictionOpen(p) ? "success" : "neutral"}>{predictionStatusLabel(p.status)}</StatusBadge>
      </div>
      <p className="text-xs text-muted-foreground">
        {p.status === "active"
          ? fillNode(t("interact.prediction.locksIn"), "time", <RelativeTime date={p.locksAt} />)
          : t("interact.prediction.pool", { count: predictionPool(p) })}
      </p>
      <TallyList
        label={t("interact.prediction.results")}
        items={p.outcomes.map((o) => {
          const payout = payouts?.find((x) => x.id === o.id);
          return {
            id: o.id,
            label: o.title,
            value: o.points,
            valueText: t("interact.prediction.outcomeTotals", {
              points: formatNumber(o.points, locale),
              count: o.users,
            }),
            tone: payout?.result === "won" ? ("success" as const) : undefined,
            note: payoutNote(payout, o.users, locale),
            badge:
              p.winningOutcomeId === o.id ? (
                <StatusBadge tone="success">{t("interact.prediction.winner")}</StatusBadge>
              ) : undefined,
            action:
              p.status === "locked" ? (
                <ConfirmDialog
                  trigger={
                    <Button type="button" size="sm" variant="outline" data-testid={`prediction-resolve-${o.id}`}>
                      {t("interact.prediction.resolveTo")}
                    </Button>
                  }
                  title={t("interact.prediction.resolveTitle", { outcome: o.title })}
                  description={t("interact.prediction.resolveBody", { outcome: o.title })}
                  confirmLabel={t("interact.prediction.resolve")}
                  onConfirm={() => onAction({ kind: "resolve", outcomeId: o.id })}
                  onError={onError}
                />
              ) : undefined,
            rowProps: {
              "data-testid": "prediction-live-outcome",
              "data-outcome-id": o.id,
              "data-points": o.points,
              "data-users": o.users,
            },
          };
        })}
      />
      {isPredictionOpen(p) ? (
        <div className="flex flex-wrap gap-2">
          {p.status === "active" ? <LockButton onLock={() => onAction({ kind: "lock" })} onError={onError} /> : null}
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" data-testid="prediction-cancel">
                {t("interact.prediction.cancel")}
              </Button>
            }
            title={t("interact.prediction.cancelTitle")}
            description={t("interact.prediction.cancelBody")}
            confirmLabel={t("interact.prediction.cancelConfirm")}
            variant="destructive"
            onConfirm={() => onAction({ kind: "cancel" })}
            onError={onError}
          />
        </div>
      ) : null}
    </div>
  );
}

function LockButton({
  onLock,
  onError,
}: {
  onLock: () => Promise<void>;
  onError: (err: unknown) => void;
}): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      type="button"
      data-testid="prediction-lock"
      disabled={pending}
      onClick={() => {
        setPending(true);
        onLock()
          .catch(onError)
          .finally(() => setPending(false));
      }}
    >
      {t("interact.prediction.lock")}
    </Button>
  );
}

type StartPrediction = (draft: PredictionDraft) => Promise<FieldErrors<PredictionField> | null>;

export function PredictionForm({ onStart }: { onStart: StartPrediction }): React.JSX.Element {
  const [draft, setDraft] = React.useState<PredictionDraft>(emptyPredictionDraft);
  const [errors, setErrors] = React.useState<FieldErrors<PredictionField>>({});
  const [pending, setPending] = React.useState(false);
  const setOutcome = (index: number, value: string) =>
    setDraft((d) => ({ ...d, outcomes: d.outcomes.map((o, i) => (i === index ? value : o)) }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const result = await onStart(draft);
      if (result) setErrors(result);
      else {
        setErrors({});
        setDraft(emptyPredictionDraft());
      }
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("interact.prediction.error.busy"));
      else if (errorRequirement(err) === "points_disabled") toast.error(t("interact.prediction.error.pointsOff"));
      else toastActionError(err, t("interact.prediction.startFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="prediction-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
      aria-label={t("interact.prediction.formLabel")}
    >
      <TextField
        label={t("interact.prediction.question")}
        value={draft.title}
        onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
        data-testid="prediction-title"
        error={errors.title}
        description={t("interact.prediction.questionHint", { max: PREDICTION_LIMITS.titleMax })}
      />
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 text-xs font-medium">{t("interact.prediction.outcomes")}</legend>
        {draft.outcomes.map((outcome, i) => {
          const n = i + 1;
          return (
            <div key={n} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={t("interact.prediction.outcome", { n })}
                  value={outcome}
                  onChange={(v) => setOutcome(i, v)}
                  data-testid={`prediction-outcome-${n}`}
                />
              </div>
              {n > PREDICTION_LIMITS.minOutcomes ? (
                <IconButton
                  type="button"
                  icon={Cancel01Icon}
                  label={t("interact.prediction.removeOutcome", { n })}
                  onClick={() => setDraft((d) => ({ ...d, outcomes: d.outcomes.filter((_, j) => j !== i) }))}
                />
              ) : null}
            </div>
          );
        })}
        {errors.outcomes ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.outcomes}
          </p>
        ) : null}
        {draft.outcomes.length < PREDICTION_LIMITS.maxOutcomes ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="prediction-add-outcome"
            onClick={() => setDraft((d) => ({ ...d, outcomes: [...d.outcomes, ""] }))}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("interact.prediction.addOutcome")}
          </Button>
        ) : null}
      </fieldset>
      <TextField
        label={t("interact.prediction.window")}
        value={draft.window}
        onChange={(v) => setDraft((d) => ({ ...d, window: v }))}
        data-testid="prediction-window"
        numeric
        error={errors.window}
        description={t("interact.prediction.windowHint", {
          min: PREDICTION_LIMITS.minSeconds,
          max: PREDICTION_LIMITS.maxSeconds,
        })}
      />
      <Button type="submit" data-testid="prediction-start" disabled={pending} className="self-start">
        {t("interact.prediction.start")}
      </Button>
    </form>
  );
}
