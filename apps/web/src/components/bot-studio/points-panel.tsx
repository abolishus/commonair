// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel points on `/bot`: the leaderboard and a moderator adjust with a reason code (never free
 * text: it goes into the audit row, ADR 0026 decision 2). A deduction below zero is refused by the
 * database and shown inline (`insufficient_points`).
 */
import { EmptyState, formatNumber, useLocale } from "@commonair/ui";
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
import { Coins01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { POINTS_ADJUST_REASONS } from "@commonair/contracts/enums";
import { t } from "../../i18n/index.ts";
import {
  adjustError,
  adjustInput,
  adjustReasonLabel,
  emptyAdjustDraft,
  isAdjustReason,
  type AdjustDraft,
  type AdjustField,
  type LoyaltyRowDto,
} from "../../lib/bot-studio.ts";
import type { FieldErrors } from "../../lib/interact-studio.ts";
import { StudioSection, TextField, type StudioApi } from "../interact-studio/shared.tsx";

/** How many top holders the page lists. */
export const LEADERBOARD_SIZE = 25;

export function PointsPanel({
  channel,
  initial,
  client,
  canAdjust,
}: {
  channel: string;
  initial: LoyaltyRowDto[];
  client: StudioApi;
  canAdjust: boolean;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [rows, setRows] = React.useState(initial);
  const [open, setOpen] = React.useState(false);
  const pointsName = rows[0]?.pointsName;

  const adjust = async (draft: AdjustDraft): Promise<FieldErrors<AdjustField> | null> => {
    const checked = adjustInput(channel, draft);
    if (!checked.ok) return checked.errors;
    const balance = await client.bot.points.adjust(checked.input);
    toast.success(
      t("bot.points.adjusted", {
        username: balance.user.username,
        points: formatNumber(balance.points, locale),
      }),
    );
    setOpen(false);
    // The order may change: read the board again rather than patching one row.
    client.bot.points
      .leaderboard({ channel, limit: LEADERBOARD_SIZE })
      .then(setRows)
      .catch(() => undefined);
    return null;
  };

  return (
    <StudioSection
      icon={Coins01Icon}
      title={t("bot.points.title")}
      description={pointsName ? t("bot.points.introNamed", { name: pointsName }) : t("bot.points.intro")}
      action={
        canAdjust ? (
          <Button type="button" size="sm" data-testid="points-adjust-open" onClick={() => setOpen(true)}>
            {t("bot.points.adjust")}
          </Button>
        ) : undefined
      }
    >
      <div data-testid="points-leaderboard">
        {rows.length === 0 ? (
          <EmptyState icon={Coins01Icon} headingLevel={3} title={t("bot.points.empty")} />
        ) : (
          <ol className="flex flex-col divide-y" aria-label={t("bot.points.leaderboard")}>
            {rows.map((row, i) => (
              <li
                key={row.user.id}
                data-testid="points-row"
                data-username={row.user.username}
                data-points={row.points}
                className="flex items-center gap-3 py-2 text-sm"
              >
                <span className="w-6 shrink-0 text-end text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{row.user.username}</span>
                <span className="tabular-nums">{formatNumber(row.points, locale)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canAdjust ? <AdjustDialog key={String(open)} open={open} onOpenChange={setOpen} onAdjust={adjust} /> : null}
    </StudioSection>
  );
}

function AdjustDialog({
  open,
  onOpenChange,
  onAdjust,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdjust: (draft: AdjustDraft) => Promise<FieldErrors<AdjustField> | null>;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<AdjustDraft>(emptyAdjustDraft);
  const [errors, setErrors] = React.useState<FieldErrors<AdjustField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      setErrors((await onAdjust(draft)) ?? {});
    } catch (err) {
      setFailure(adjustError(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form data-testid="points-adjust" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("bot.points.adjustTitle")}</DialogTitle>
            <DialogDescription>{t("bot.points.adjustHint")}</DialogDescription>
          </DialogHeader>
          <TextField
            label={t("bot.points.user")}
            value={draft.username}
            onChange={(username) => setDraft((d) => ({ ...d, username }))}
            data-testid="points-adjust-user"
            error={errors.username}
          />
          <TextField
            label={t("bot.points.delta")}
            value={draft.delta}
            onChange={(delta) => setDraft((d) => ({ ...d, delta }))}
            data-testid="points-adjust-delta"
            error={errors.delta}
            description={t("bot.points.deltaHint")}
          />
          <SelectField
            label={t("bot.points.reason")}
            value={draft.reason}
            triggerProps={{ "data-testid": "points-adjust-reason" }}
            options={POINTS_ADJUST_REASONS.map((reason) => ({
              value: reason,
              label: adjustReasonLabel(reason),
              "data-testid": `points-adjust-reason-${reason}`,
            }))}
            onValueChange={(value) => {
              if (isAdjustReason(value)) setDraft((d) => ({ ...d, reason: value }));
            }}
          />
          {failure ? (
            <p data-testid="points-adjust-error" role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {t("bot.cancel")}
            </Button>
            <Button type="submit" data-testid="points-adjust-submit" disabled={pending}>
              {t("bot.points.adjustSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
