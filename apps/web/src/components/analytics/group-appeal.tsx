// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Appeal this group" on an excluded group of the analytics page (`appeals.create` with subject
 * `exclusion_group`, decision (m); docs/testing/w2-selectors.md "Analytics"). The dialog says what
 * an appeal covers and how many are left this week; the row shows the decided result. Disabled,
 * with the reason in a tooltip (and to screen readers), once the broadcast has its one group
 * appeal or the week's appeals are used.
 */
import {
  ANALYTICS_RULES,
  type EXCLUSION_CATEGORIES,
  GROUP_APPEAL_RULES,
  type APPEAL_STATUSES,
} from "@commonair/contracts/enums";
import { StatusBadge, type StatusTone, formatDateTime, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  type Appeal,
  type GroupAppealClient,
  type GroupAppealView,
  groupAppealView,
  rateLimitedFor,
  useGroupAppeals,
} from "./group-appeal-data.ts";

export interface GroupAppealActionProps {
  broadcastId: string;
  category: (typeof EXCLUSION_CATEGORIES)[number];
  /** Sessions in the excluded group (shown groups have at least 5). */
  sessions: number;
  /** Injectable for render tests; the app's client otherwise. */
  client?: GroupAppealClient;
  /** Clock for render tests (ms epoch); the current time otherwise. */
  now?: number;
}

export const GROUP_APPEAL_BODY_MIN = 10;
export const GROUP_APPEAL_BODY_MAX = 5000;

const STATUS_TONE: Record<(typeof APPEAL_STATUSES)[number], StatusTone> = {
  open: "warning",
  upheld: "neutral",
  overturned: "success",
};

export function GroupAppealAction({
  broadcastId,
  category,
  sessions,
  client,
  now,
}: GroupAppealActionProps): React.JSX.Element | null {
  const appeals = useGroupAppeals(client);
  const [open, setOpen] = React.useState(false);
  // Read once per mount (and on each open): the window moves by days, not seconds.
  const [clock, setClock] = React.useState(() => now ?? Date.now());
  if (sessions < ANALYTICS_RULES.minGroupSessions) return null;
  if (appeals.appeals === null && !appeals.failed)
    return (
      <Button data-testid="group-appeal-open" variant="outline" size="sm" disabled aria-busy>
        {t("analytics.groupAppeal.loading")}
      </Button>
    );
  // Without the list the server still decides: offer the appeal and let it refuse.
  const view = groupAppealView(appeals.appeals ?? [], { broadcastId, category, now: now ?? clock });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {view.own ? (
        <AppealStatus appeal={view.own} />
      ) : view.broadcastAppeal ? (
        <AppealStatus appeal={view.broadcastAppeal} other />
      ) : null}
      {view.state === "available" ? (
        <Button
          data-testid="group-appeal-open"
          data-state="available"
          variant="outline"
          size="sm"
          onClick={() => {
            setClock(Date.now());
            setOpen(true);
          }}
        >
          {t("analytics.groupAppeal.open")}
        </Button>
      ) : (
        <DisabledOpen view={view} />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="group-appeal-dialog">
          <GroupAppealDialogBody
            view={view}
            category={category}
            sessions={sessions}
            onSubmit={async (body) => {
              try {
                await appeals.create({ broadcastId, category, body });
                toast.success(t("analytics.groupAppeal.done"));
              } catch (err) {
                if (rateLimitedFor(err) !== null) {
                  toast.error(t("analytics.groupAppeal.rateLimited"));
                  // The list was stale (another tab, another group): read it again.
                  appeals.reload();
                } else toastActionError(err, t("analytics.groupAppeal.failed"));
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The appeal's status; `other` when it is another group's appeal on the broadcast, named. */
function AppealStatus({ appeal, other = false }: { appeal: Appeal; other?: boolean }): React.JSX.Element {
  return (
    <StatusBadge
      data-testid="group-appeal-status"
      data-status={appeal.status}
      data-category={appeal.exclusionCategory ?? undefined}
      tone={STATUS_TONE[appeal.status]}
    >
      {other
        ? t("analytics.groupAppeal.statusOther", {
            status: appeal.status,
            category: t("analytics.category", { category: appeal.exclusionCategory ?? "other" }),
          })
        : t("analytics.groupAppeal.status", { status: appeal.status })}
    </StatusBadge>
  );
}

function DisabledOpen({ view }: { view: GroupAppealView }): React.JSX.Element {
  const { locale } = useLocale();
  const reasonId = React.useId();
  // The dialog does not reopen once appealed, so the reason carries the result text.
  const reason = view.own
    ? `${t("analytics.groupAppeal.reason.own")} ${t("analytics.groupAppeal.result", { status: view.own.status })}`
    : view.state === "appealed"
      ? t("analytics.groupAppeal.reason.broadcast")
      : t("analytics.groupAppeal.reason.limited", {
          perChannel: GROUP_APPEAL_RULES.perChannel,
          date: view.nextAt ? formatDateTime(new Date(view.nextAt), locale) : "",
        });
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-testid="group-appeal-open"
              data-state={view.state}
              variant="outline"
              size="sm"
              disabled
              focusableWhenDisabled
              aria-describedby={reasonId}
              className="aria-disabled:opacity-50"
            />
          }
        >
          {view.state === "appealed" ? t("analytics.groupAppeal.appealed") : t("analytics.groupAppeal.limited")}
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

/** The dialog's contents: what an appeal covers and the form, or once sent, its status. */
export function GroupAppealDialogBody({
  view,
  category,
  sessions,
  onSubmit,
}: {
  view: GroupAppealView;
  category: GroupAppealActionProps["category"];
  sessions: number;
  onSubmit: (body: string) => Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const id = React.useId();
  const length = body.trim().length;
  const valid = length >= GROUP_APPEAL_BODY_MIN && length <= GROUP_APPEAL_BODY_MAX;
  const header = (
    <DialogHeader>
      <DialogTitle>{t("analytics.groupAppeal.title")}</DialogTitle>
      <DialogDescription>
        {t("analytics.groupAppeal.description", {
          sessions,
          category: t("analytics.category", { category }),
        })}
      </DialogDescription>
    </DialogHeader>
  );
  if (view.own)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div className="flex flex-col items-start gap-2">
          <AppealStatus appeal={view.own} />
          <p className="text-sm text-muted-foreground">
            {t("analytics.groupAppeal.result", { status: view.own.status })}
          </p>
        </div>
      </div>
    );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSubmit(body.trim());
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      {header}
      <p className="text-sm">{t("analytics.groupAppeal.covers")}</p>
      <p className="text-sm text-muted-foreground">
        {t("analytics.groupAppeal.rules", { perChannel: GROUP_APPEAL_RULES.perChannel })}{" "}
        <span data-testid="group-appeal-limit" data-remaining={view.remaining} className="font-medium text-foreground">
          {t("analytics.groupAppeal.remaining", { remaining: view.remaining })}
        </span>
      </p>
      <Field>
        <FieldLabel htmlFor={id}>{t("analytics.groupAppeal.body")}</FieldLabel>
        <Textarea
          id={id}
          rows={5}
          minLength={GROUP_APPEAL_BODY_MIN}
          maxLength={GROUP_APPEAL_BODY_MAX}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <FieldDescription>
          {t("analytics.groupAppeal.bodyHint", { min: GROUP_APPEAL_BODY_MIN, max: GROUP_APPEAL_BODY_MAX })}
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button
          data-testid="group-appeal-submit"
          type="submit"
          disabled={!valid || pending || view.state !== "available"}
          aria-busy={pending || undefined}
        >
          {t("analytics.groupAppeal.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
