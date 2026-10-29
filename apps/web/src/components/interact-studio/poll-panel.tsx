// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Polls on `/interact` (docs/testing/e8-selectors.md "Polls"): the form while none runs, the live
 * card with counts refreshed every 2 s while active, end (confirmed) and archive once ended.
 */
import { ConfirmDialog, IconButton, RelativeTime, StatusBadge } from "@commonair/ui";
import { TallyList } from "@commonair/ui/blocks/interact-studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Cancel01Icon, ChartBarLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import {
  POLL_LIMITS,
  canArchivePoll,
  canStartPoll,
  emptyPollDraft,
  pollInput,
  pollStatusLabel,
  pollTotal,
  type FieldErrors,
  type PollDraft,
  type PollDto,
  type PollField,
} from "../../lib/interact-studio.ts";
import { StudioSection, TextField, useLiveState, usePolling, type StudioApi } from "./shared.tsx";

/** How often the live card re-reads the counts while the poll runs. */
export const POLL_REFRESH_MS = 2000;

export function PollPanel({
  channel,
  initial,
  client,
  refreshMs = POLL_REFRESH_MS,
}: {
  channel: string;
  initial: PollDto | null;
  client: StudioApi;
  refreshMs?: number;
}): React.JSX.Element {
  const [poll, setPoll, refreshPoll] = useLiveState(initial);
  usePolling(poll?.status === "active", refreshMs, () => refreshPoll(() => client.interact.polls.current({ channel })));

  const end = async (status: "terminated" | "archived"): Promise<void> => {
    if (!poll) return;
    const next = await client.interact.polls.end({ id: poll.id, status });
    setPoll(status === "archived" ? null : next);
    toast.success(status === "archived" ? t("interact.poll.archived") : t("interact.poll.ended"));
  };

  return (
    <StudioSection icon={ChartBarLineIcon} title={t("interact.poll.title")} description={t("interact.poll.intro")}>
      {poll ? <PollLive poll={poll} onEnd={end} /> : null}
      {canStartPoll(poll) ? (
        <PollForm
          onStart={async (draft) => {
            const checked = pollInput(channel, draft);
            if (!checked.ok) return checked.errors;
            const created = await client.interact.polls.create(checked.input);
            setPoll(created);
            toast.success(t("interact.poll.started"));
            return null;
          }}
        />
      ) : null}
    </StudioSection>
  );
}

function PollLive({
  poll,
  onEnd,
}: {
  poll: PollDto;
  onEnd: (status: "terminated" | "archived") => Promise<void>;
}): React.JSX.Element {
  const total = pollTotal(poll);
  const active = poll.status === "active";
  const [archiving, setArchiving] = React.useState(false);
  return (
    <div
      data-testid="poll-live"
      data-poll-id={poll.id}
      data-status={poll.status}
      data-ends-at={poll.endsAt}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium break-words">{poll.title}</h3>
        <StatusBadge tone={active ? "success" : "neutral"}>{pollStatusLabel(poll.status)}</StatusBadge>
      </div>
      <p className="text-xs text-muted-foreground">
        {active
          ? fillNode(t("interact.poll.endsIn"), "time", <RelativeTime date={poll.endsAt} />)
          : t("interact.poll.totalVotes", { count: total })}
      </p>
      <TallyList
        label={t("interact.poll.results")}
        items={poll.choices.map((c) => ({
          id: c.id,
          label: c.title,
          value: c.votes,
          valueText: t("interact.poll.votes", { count: c.votes }),
          rowProps: { "data-testid": "poll-live-choice", "data-choice-id": c.id, "data-votes": c.votes },
        }))}
      />
      {poll.pointsPerExtraVote > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("interact.poll.extraVotesOn", { points: poll.pointsPerExtraVote })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {active ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" data-testid="poll-end">
                {t("interact.poll.end")}
              </Button>
            }
            title={t("interact.poll.endTitle")}
            description={t("interact.poll.endBody")}
            confirmLabel={t("interact.poll.end")}
            variant="destructive"
            onConfirm={() => onEnd("terminated")}
            onError={(err) => toastActionError(err, t("interact.poll.endFailed"))}
          />
        ) : null}
        {canArchivePoll(poll) ? (
          <Button
            type="button"
            variant="outline"
            data-testid="poll-archive"
            disabled={archiving}
            onClick={() => {
              setArchiving(true);
              onEnd("archived")
                .catch((err: unknown) => toastActionError(err, t("interact.poll.archiveFailed")))
                .finally(() => setArchiving(false));
            }}
          >
            {t("interact.poll.archive")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Returns field errors to show, or null once the poll started. */
type StartPoll = (draft: PollDraft) => Promise<FieldErrors<PollField> | null>;

export function PollForm({ onStart }: { onStart: StartPoll }): React.JSX.Element {
  const [draft, setDraft] = React.useState<PollDraft>(emptyPollDraft);
  const [errors, setErrors] = React.useState<FieldErrors<PollField>>({});
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof PollDraft>(key: K, value: PollDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setChoice = (index: number, value: string) =>
    setDraft((d) => ({ ...d, choices: d.choices.map((c, i) => (i === index ? value : c)) }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const result = await onStart(draft);
      if (result) setErrors(result);
      else {
        setErrors({});
        setDraft(emptyPollDraft());
      }
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("interact.poll.error.busy"));
      else toastActionError(err, t("interact.poll.startFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="poll-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
      aria-label={t("interact.poll.formLabel")}
    >
      <TextField
        label={t("interact.poll.question")}
        value={draft.title}
        onChange={(v) => set("title", v)}
        data-testid="poll-title"
        error={errors.title}
        description={t("interact.poll.questionHint", { max: POLL_LIMITS.titleMax })}
      />
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 text-xs font-medium">{t("interact.poll.choices")}</legend>
        {draft.choices.map((choice, i) => {
          const n = i + 1;
          return (
            <div key={n} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={t("interact.poll.choice", { n })}
                  value={choice}
                  onChange={(v) => setChoice(i, v)}
                  data-testid={`poll-choice-${n}`}
                />
              </div>
              {n > POLL_LIMITS.minChoices ? (
                <IconButton
                  type="button"
                  icon={Cancel01Icon}
                  label={t("interact.poll.removeChoice", { n })}
                  onClick={() => setDraft((d) => ({ ...d, choices: d.choices.filter((_, j) => j !== i) }))}
                />
              ) : null}
            </div>
          );
        })}
        {errors.choices ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.choices}
          </p>
        ) : null}
        {draft.choices.length < POLL_LIMITS.maxChoices ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="poll-add-choice"
            onClick={() => setDraft((d) => ({ ...d, choices: [...d.choices, ""] }))}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("interact.poll.addChoice")}
          </Button>
        ) : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t("interact.poll.duration")}
          value={draft.duration}
          onChange={(v) => set("duration", v)}
          data-testid="poll-duration"
          numeric
          error={errors.duration}
          description={t("interact.poll.durationHint", {
            min: POLL_LIMITS.minSeconds,
            max: POLL_LIMITS.maxSeconds,
          })}
        />
        <TextField
          label={t("interact.poll.extraCost")}
          value={draft.extraCost}
          onChange={(v) => set("extraCost", v)}
          data-testid="poll-extra-cost"
          numeric
          error={errors.extraCost}
          description={t("interact.poll.extraCostHint")}
        />
      </div>
      <Button type="submit" data-testid="poll-start" disabled={pending} className="self-start">
        {t("interact.poll.start")}
      </Button>
    </form>
  );
}
