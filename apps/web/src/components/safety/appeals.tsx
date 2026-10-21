// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { JusticeScale01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { appealsClient, type AppealDto, type AppealsClient, type ContentLabelDto } from "./client.ts";
import { appealStatusBadge } from "./labels.ts";

export const APPEAL_BODY_MIN = 10;
export const APPEAL_BODY_MAX = 5000;

/** An appeal for this label is waiting for a moderator. */
export function hasOpenAppeal(label: ContentLabelDto, appeals: readonly AppealDto[]): boolean {
  return appeals.some((a) => a.subjectType === "content_label" && a.subjectId === label.id && a.status === "open");
}

export interface LabelNoticeProps {
  label: ContentLabelDto;
  appealPending: boolean;
  onAppeal: () => void;
}

/** `moderation-label-notice`: an active label on the viewer's channel, with the appeal action. */
export function LabelNotice({ label, appealPending, onAppeal }: LabelNoticeProps): React.JSX.Element {
  return (
    <AlertCallout
      data-testid="moderation-label-notice"
      data-label-id={label.id}
      data-label={label.label}
      tone="warning"
      title={t("safety.label.title")}
      description={
        <p>
          {t("safety.label.body")} <RelativeTime date={label.appliedAt} />
        </p>
      }
      action={
        <Button data-testid="label-appeal-open" variant="outline" size="sm" disabled={appealPending} onClick={onAppeal}>
          {appealPending ? t("safety.label.appealPending") : t("safety.label.appeal")}
        </Button>
      }
    />
  );
}

/** `label-appeal-dialog`: why the label is wrong, 10–5000 characters. */
export function LabelAppealForm({ onSubmit }: { onSubmit: (body: string) => Promise<void> }): React.JSX.Element {
  const [body, setBody] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const id = React.useId();
  const length = body.trim().length;
  const valid = length >= APPEAL_BODY_MIN && length <= APPEAL_BODY_MAX;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSubmit(body.trim());
      toast.success(t("safety.label.appealDone"));
    } catch (err) {
      toastActionError(err, t("safety.label.appealFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{t("safety.label.appealTitle")}</DialogTitle>
        <DialogDescription>{t("safety.label.appealDescription")}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={id}>{t("safety.label.appealBody")}</FieldLabel>
        <Textarea
          id={id}
          data-testid="label-appeal-body"
          rows={5}
          minLength={APPEAL_BODY_MIN}
          maxLength={APPEAL_BODY_MAX}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <FieldDescription>
          {t("safety.label.appealBodyHint", { min: APPEAL_BODY_MIN, max: APPEAL_BODY_MAX })}
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button
          data-testid="label-appeal-submit"
          type="submit"
          disabled={!valid || pending}
          aria-busy={pending || undefined}
        >
          {t("safety.label.appealSubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface LabelNoticesProps {
  labels: readonly ContentLabelDto[];
  appeals: readonly AppealDto[];
  onAppeal: (label: ContentLabelDto, body: string) => Promise<void>;
}

/** Every active label with its notice, and the appeal dialog for the one being appealed. */
export function LabelNotices({ labels, appeals, onAppeal }: LabelNoticesProps): React.JSX.Element | null {
  const [appealing, setAppealing] = React.useState<ContentLabelDto | null>(null);
  const active = labels.filter((l) => l.removedAt === null);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {active.map((label) => (
        <LabelNotice
          key={label.id}
          label={label}
          appealPending={hasOpenAppeal(label, appeals)}
          onAppeal={() => setAppealing(label)}
        />
      ))}
      <Dialog open={appealing !== null} onOpenChange={(open) => !open && setAppealing(null)}>
        {appealing && (
          <DialogContent data-testid="label-appeal-dialog" data-label-id={appealing.id} className="sm:max-w-lg">
            <LabelAppealForm
              onSubmit={async (body) => {
                await onAppeal(appealing, body);
                setAppealing(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/** One appeal of the viewer (`appeal-row`). */
export function AppealList({ appeals }: { appeals: readonly AppealDto[] | null }): React.JSX.Element {
  if (appeals === null)
    return (
      <SkeletonGroup label={t("safety.appeals.loading")}>
        <SkeletonText lines={3} />
      </SkeletonGroup>
    );
  if (appeals.length === 0)
    return (
      <EmptyState
        data-testid="appeals-empty"
        icon={JusticeScale01Icon}
        title={t("safety.appeals.empty")}
        description={t("safety.appeals.emptyHint")}
        headingLevel={3}
      />
    );
  return (
    <ItemGroup>
      {appeals.map((appeal) => {
        const badge = appealStatusBadge(appeal.status);
        return (
          <Item
            key={appeal.id}
            data-testid="appeal-row"
            data-appeal-id={appeal.id}
            data-subject-type={appeal.subjectType}
            data-status={appeal.status}
            variant="outline"
            size="sm"
          >
            <ItemContent>
              <ItemTitle>
                {appeal.subjectType === "content_label"
                  ? t("safety.appeals.labelSubject")
                  : t("safety.appeals.otherSubject")}
              </ItemTitle>
              <ItemDescription>{appeal.resolution ?? appeal.body}</ItemDescription>
            </ItemContent>
            <ItemActions className="flex-col items-end gap-1">
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              <RelativeTime date={appeal.resolvedAt ?? appeal.createdAt} className="text-xs text-muted-foreground" />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

interface AppealsData {
  labels: ContentLabelDto[] | null;
  appeals: AppealDto[] | null;
  failed: boolean;
  appeal: (label: ContentLabelDto, body: string) => Promise<void>;
}

/** `me.labels` and `appeals.mine`, loaded together; a new appeal is added to the list. */
export function useAppeals(client: AppealsClient): AppealsData {
  const [labels, setLabels] = React.useState<ContentLabelDto[] | null>(null);
  const [appeals, setAppeals] = React.useState<AppealDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const clientRef = React.useRef(client);
  React.useEffect(() => {
    let live = true;
    Promise.all([clientRef.current.labels(), clientRef.current.mine()])
      .then(([l, a]) => {
        if (!live) return;
        setLabels(l);
        setAppeals(a);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return {
    labels,
    appeals,
    failed,
    appeal: async (label, body) => {
      const created = await clientRef.current.appealLabel(label.id, body);
      setAppeals((list) => [created, ...(list ?? [])]);
    },
  };
}

/** `/settings/appeals` content: label notices on top, then every appeal. */
export function MyAppeals({ client = appealsClient() }: { client?: AppealsClient }): React.JSX.Element {
  const data = useAppeals(client);
  if (data.failed) return <FormError>{t("safety.appeals.loadFailed")}</FormError>;
  return (
    <>
      <LabelNotices labels={data.labels ?? []} appeals={data.appeals ?? []} onAppeal={data.appeal} />
      <AppealList appeals={data.appeals} />
    </>
  );
}

/** The dashboard's label notices (nothing while loading, on failure or without labels). */
export function DashboardLabelNotices({
  client = appealsClient(),
}: {
  client?: AppealsClient;
}): React.JSX.Element | null {
  const data = useAppeals(client);
  if (data.labels === null || data.appeals === null) return null;
  return <LabelNotices labels={data.labels} appeals={data.appeals} onAppeal={data.appeal} />;
}
