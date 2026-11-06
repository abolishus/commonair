// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { ArrowDown01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
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

/** `/admin/appeals`: open appeals, each a row that opens to resolve it in place. */
export function AppealQueue({ client: clientProp }: { client?: AppealQueueClient }): React.JSX.Element {
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
        onResolve={async (appeal, status, resolution) => {
          await client.resolve({ id: appeal.id, status, resolution });
          appeals.reload();
        }}
      />
      {appeals.hasMore && (
        <div>
          <Button variant="ghost" size="sm" disabled={appeals.loadingMore} onClick={appeals.loadMore}>
            {t("safety.modq.loadMore")}
          </Button>
        </div>
      )}
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
 * F36: each appeal is a row (subject, the start of its text, kind, status, age) that opens in
 * place to the full text and the decision form. One row is open at a time, so the open form is
 * the only one on the page; drafts live here, so closing a row keeps what was typed.
 */
export function AppealQueueList({
  appeals,
  onResolve,
}: {
  appeals: AppealDto[] | null;
  onResolve: (appeal: AppealDto, status: Decision, resolution: string) => Promise<void>;
}): React.JSX.Element {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Readonly<Record<string, Draft>>>({});
  if (appeals === null)
    return (
      <SkeletonGroup label={t("safety.appealq.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (appeals.length === 0)
    return <EmptyState icon={CheckmarkCircle02Icon} title={t("safety.appealq.empty")} headingLevel={3} />;
  return (
    <ul className="flex flex-col divide-y rounded-md border" aria-label={t("safety.appealq.title")}>
      {appeals.map((appeal) => (
        <AppealRow
          key={appeal.id}
          appeal={appeal}
          open={openId === appeal.id}
          onOpenChange={(open) => setOpenId(open ? appeal.id : null)}
          draft={drafts[appeal.id] ?? EMPTY_DRAFT}
          onDraft={(draft) => setDrafts((prev) => ({ ...prev, [appeal.id]: draft }))}
          onResolve={async (s, r) => {
            await onResolve(appeal, s, r);
            setDrafts((prev) => {
              const { [appeal.id]: _resolved, ...rest } = prev;
              return rest;
            });
          }}
        />
      ))}
    </ul>
  );
}

function AppealRow({
  appeal,
  open,
  onOpenChange,
  draft,
  onDraft,
  onResolve,
}: {
  appeal: AppealDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    <li
      data-testid="appealq-item"
      data-appeal-id={appeal.id}
      data-kind={appeal.kind}
      data-subject-type={appeal.subjectType}
      data-status={appeal.status}
      data-open={open ? "true" : "false"}
      className="min-w-0"
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        {/* The whole collapsed row is the toggle, so a click anywhere on it opens the appeal. */}
        <CollapsibleTrigger
          data-testid="appealq-item-toggle"
          className="group/appeal flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 p-3 text-start outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/appeal:rotate-180 motion-reduce:transition-none"
          />
          <span className="text-sm font-medium">{appealSubjectLabel(appeal.subjectType)}</span>
          <span className="min-w-0 flex-1 basis-40 truncate text-sm text-muted-foreground">{appeal.body}</span>
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral">{appealKindLabel(appeal.kind)}</StatusBadge>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            <RelativeTime date={appeal.createdAt} className="text-xs text-muted-foreground" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent data-testid="appealq-detail" className="px-3 pb-3">
          <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
            <p className="text-sm break-words whitespace-pre-wrap">{appeal.body}</p>
            {effect && (
              <p className="text-sm text-muted-foreground" data-effect={effect}>
                {overturnEffectLabel(effect)}
              </p>
            )}
            {appeal.status === "open" && (
              <>
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
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
