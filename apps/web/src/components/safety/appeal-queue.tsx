// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { QueueLayout } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { queueShortcuts } from "./mod-queue.tsx";
import { FormError } from "../form-error.tsx";
import { usePaged } from "../money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { appealQueueClient, type AppealDto, type AppealQueueClient } from "./client.ts";
import {
  appealKindLabel,
  appealStatusBadge,
  appealSubjectLabel,
  overturnEffect,
  overturnEffectLabel,
} from "./labels.ts";

export const RESOLUTION_MAX = 5000;

/**
 * `/admin/appeals`: open appeals in a QueueLayout; a row opens the appeal beside the list to resolve it.
 * With `onOpenChange` the open appeal is controlled (the route keeps it in `?case=`).
 */
export function AppealQueue({
  client: clientProp,
  openId,
  onOpenChange,
}: {
  client?: AppealQueueClient;
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? appealQueueClient());
  const appeals = usePaged(
    "appeals",
    (cursor) => client.queue(cursor),
    (err) => toastActionError(err, t("safety.appealq.loadMoreFailed")),
  );
  return (
    <div className="flex flex-col gap-4">
      {appeals.failed && <FormError>{t("safety.appealq.loadFailed")}</FormError>}
      <AppealQueueList
        appeals={appeals.items ?? (appeals.failed ? [] : null)}
        hasMore={appeals.hasMore}
        footer={
          appeals.hasMore ? (
            <div>
              <Button
                data-testid="appealq-load-more"
                variant="ghost"
                size="sm"
                disabled={appeals.loadingMore}
                onClick={appeals.loadMore}
              >
                {t("safety.modq.loadMore")}
              </Button>
            </div>
          ) : null
        }
        {...(onOpenChange ? { openId: openId ?? null, onOpenChange } : {})}
        onResolve={async (appeal, status, resolution) => {
          await client.resolve({ id: appeal.id, status, resolution });
          appeals.reload();
        }}
      />
    </div>
  );
}

type Decision = "upheld" | "overturned";
interface Draft {
  status: Decision | "";
  resolution: string;
}
const EMPTY_DRAFT: Draft = { status: "", resolution: "" };

/**
 * F36, D7.5: each appeal is a row (subject, the start of its text, kind, status, age) in the
 * QueueLayout list; the open one's full text and decision form are in the detail pane (below lg,
 * in place of the list, with Back). One appeal is open at a time, so its form is the only one on
 * the page; drafts live here, so closing an appeal keeps what was typed. Appeals are never
 * decided in bulk: each needs its own reasoned resolution.
 */
export function AppealQueueList({
  appeals,
  onResolve,
  hasMore = false,
  footer,
  openId: openIdProp,
  onOpenChange,
}: {
  appeals: AppealDto[] | null;
  onResolve: (appeal: AppealDto, status: Decision, resolution: string) => Promise<void>;
  /** More appeals exist past the loaded page: the count says "at least". */
  hasMore?: boolean;
  /** Rendered under the rows inside the list pane (Load more). */
  footer?: React.ReactNode;
  /** Controlled open appeal; without `onOpenChange` the list keeps it itself. */
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
}): React.JSX.Element {
  const [ownOpenId, setOwnOpenId] = React.useState<string | null>(null);
  const openId = onOpenChange ? (openIdProp ?? null) : ownOpenId;
  const setOpenId = onOpenChange ?? setOwnOpenId;
  const [drafts, setDrafts] = React.useState<Readonly<Record<string, Draft>>>({});
  const detailId = React.useId();
  if (appeals === null)
    return (
      <SkeletonGroup label={t("safety.appealq.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (appeals.length === 0)
    return <EmptyState icon={CheckmarkCircle02Icon} title={t("safety.appealq.empty")} headingLevel={3} />;
  const open = appeals.find((a) => a.id === openId) ?? null;
  return (
    <QueueLayout
      listLabel={t("safety.appealq.title")}
      detailLabel={t("d7Admin.queue.detail")}
      count={
        <span data-testid="appealq-count">
          {hasMore
            ? t("d7Admin.queue.resultsMore", { count: appeals.length })
            : t("d7Admin.queue.results", { count: appeals.length })}
        </span>
      }
      list={
        <>
          <ul className="flex flex-col gap-2" aria-label={t("safety.appealq.title")}>
            {appeals.map((appeal) => (
              <AppealRow
                key={appeal.id}
                appeal={appeal}
                open={openId === appeal.id}
                detailId={detailId}
                onToggle={() => setOpenId(openId === appeal.id ? null : appeal.id)}
              />
            ))}
          </ul>
          {footer}
        </>
      }
      detail={
        open ? (
          <AppealDetail
            key={open.id}
            id={detailId}
            appeal={open}
            draft={drafts[open.id] ?? EMPTY_DRAFT}
            onDraft={(draft) => setDrafts((prev) => ({ ...prev, [open.id]: draft }))}
            onResolve={async (s, r) => {
              await onResolve(open, s, r);
              setDrafts((prev) => {
                const { [open.id]: _resolved, ...rest } = prev;
                return rest;
              });
            }}
          />
        ) : null
      }
      detailEmpty={t("d7Admin.queue.pick")}
      onBack={() => setOpenId(null)}
      backLabel={t("d7Admin.queue.back")}
      shortcuts={queueShortcuts()}
    />
  );
}

function AppealRow({
  appeal,
  open,
  detailId,
  onToggle,
}: {
  appeal: AppealDto;
  open: boolean;
  detailId: string;
  onToggle: () => void;
}): React.JSX.Element {
  const badge = appealStatusBadge(appeal.status);
  return (
    <li
      data-testid="appealq-item"
      data-appeal-id={appeal.id}
      data-kind={appeal.kind}
      data-subject-type={appeal.subjectType}
      data-status={appeal.status}
      data-open={open ? "true" : "false"}
      className="min-w-0"
    >
      {/* The whole row is the toggle, so a click anywhere on it opens the appeal (j/k move here). */}
      <Button
        data-testid="appealq-item-toggle"
        data-queue-row=""
        variant={open ? "secondary" : "ghost"}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={onToggle}
        className="flex h-auto w-full min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-1 p-3 text-start whitespace-normal ring-1 ring-border"
      >
        <span className="text-sm font-medium">{appealSubjectLabel(appeal.subjectType)}</span>
        <span className="min-w-0 flex-1 basis-40 truncate text-sm font-normal text-muted-foreground">
          {appeal.body}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">{appealKindLabel(appeal.kind)}</StatusBadge>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          <RelativeTime date={appeal.createdAt} className="text-xs text-muted-foreground" />
        </span>
      </Button>
    </li>
  );
}

function AppealDetail({
  id: detailId,
  appeal,
  draft,
  onDraft,
  onResolve,
}: {
  id: string;
  appeal: AppealDto;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onResolve: (status: Decision, resolution: string) => Promise<void>;
}): React.JSX.Element {
  const { status, resolution } = draft;
  const [pending, setPending] = React.useState(false);
  const id = React.useId();
  const badge = appealStatusBadge(appeal.status);
  // The queue's DTO does not carry the appealed action, so the subject's general rule is shown.
  const effect = overturnEffect(appeal.subjectType);
  const ready = status !== "" && resolution.trim() !== "";
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status === "" || resolution.trim() === "" || pending) return;
    setPending(true);
    try {
      await onResolve(status, resolution.trim());
      toast.success(t("safety.appealq.resolved"));
    } catch (err) {
      toastActionError(err, t("safety.appealq.failed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <div id={detailId} data-testid="appealq-detail" data-appeal-id={appeal.id} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{appealSubjectLabel(appeal.subjectType)}</h2>
        <StatusBadge tone="neutral">{appealKindLabel(appeal.kind)}</StatusBadge>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      </div>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <p className="text-sm break-words whitespace-pre-wrap">{appeal.body}</p>
        {effect && (
          <p className="text-sm text-muted-foreground" data-effect={effect}>
            {overturnEffectLabel(effect)}
          </p>
        )}
        {appeal.status === "open" && (
          <>
            <div data-queue-decision="">
              <ChoiceToggle
                data-testid="appealq-resolve"
                label={t("safety.appealq.decision")}
                value={status}
                onValueChange={(v) => {
                  if (v === "upheld" || v === "overturned") onDraft({ ...draft, status: v });
                }}
                options={[
                  { value: "upheld", label: t("safety.appealq.upheld"), "data-testid": "appealq-resolve-upheld" },
                  {
                    value: "overturned",
                    label: t("safety.appealq.overturned"),
                    "data-testid": "appealq-resolve-overturned",
                  },
                ]}
              />
            </div>
            <Field>
              <FieldLabel htmlFor={id}>{t("safety.appealq.resolution")}</FieldLabel>
              <Textarea
                id={id}
                data-testid="appealq-resolution"
                rows={3}
                maxLength={RESOLUTION_MAX}
                value={resolution}
                onChange={(e) => onDraft({ ...draft, resolution: e.currentTarget.value })}
              />
              <FieldDescription>{t("safety.appealq.resolutionHint")}</FieldDescription>
            </Field>
            <div>
              <Button
                data-testid="appealq-submit"
                type="submit"
                disabled={!ready || pending}
                aria-busy={pending || undefined}
              >
                {t("safety.appealq.submit")}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
