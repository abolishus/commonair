// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Section } from "@commonair/ui/blocks/headers";
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
import { JusticeScale01Icon, UserShield01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { FormError } from "../form-error.tsx";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import {
  accountActionsClient,
  appealsClient,
  type AccountActionDto,
  type AccountActionsClient,
  type AppealDto,
  type AppealsClient,
  type ContentLabelDto,
} from "./client.ts";
import { accountActionLabel, appealStatusBadge, appealSubjectLabel, reversalLabel } from "./labels.ts";

export const APPEAL_BODY_MIN = 10;
export const APPEAL_BODY_MAX = 5000;

/** An appeal for this label is waiting for a moderator. */
export function hasOpenAppeal(label: ContentLabelDto, appeals: readonly AppealDto[]): boolean {
  return appeals.some((a) => a.subjectType === "content_label" && a.subjectId === label.id && a.status === "open");
}

/** An appeal of this account action is waiting for a moderator. */
export function hasOpenAccountAppeal(action: AccountActionDto, appeals: readonly AppealDto[]): boolean {
  return appeals.some((a) => a.subjectType === "account_action" && a.subjectId === action.id && a.status === "open");
}

/** An account action can be appealed while it is in effect and no appeal of it is open. */
export const mayAppealAccountAction = (action: AccountActionDto, appeals: readonly AppealDto[]): boolean =>
  action.reversedAt === null && !hasOpenAccountAppeal(action, appeals);

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

export interface AppealFormText {
  title: string;
  description: string;
  body: string;
  hint: string;
  submit: string;
  done: string;
  failed: string;
}

/** The appeal body form shared by the label, account-action and statement-of-reasons dialogs (10–5000 characters). */
export function AppealBodyForm({
  renderBody,
  renderSubmit,
  text,
  onSubmit,
}: {
  /** The textarea and button carry their literal test ids (the selector tests read the source). */
  renderBody: (props: React.ComponentProps<typeof Textarea>) => React.JSX.Element;
  renderSubmit: (props: React.ComponentProps<typeof Button>) => React.JSX.Element;
  text: AppealFormText;
  onSubmit: (body: string) => Promise<void>;
}): React.JSX.Element {
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
      toast.success(text.done);
    } catch (err) {
      toastActionError(err, text.failed);
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={id}>{text.body}</FieldLabel>
        {renderBody({
          id,
          rows: 5,
          minLength: APPEAL_BODY_MIN,
          maxLength: APPEAL_BODY_MAX,
          value: body,
          onChange: (e) => setBody(e.currentTarget.value),
        })}
        <FieldDescription>{text.hint}</FieldDescription>
      </Field>
      <DialogFooter>
        {renderSubmit({
          type: "submit",
          disabled: !valid || pending,
          "aria-busy": pending || undefined,
          children: text.submit,
        })}
      </DialogFooter>
    </form>
  );
}

/** `label-appeal-dialog`: why the label is wrong, 10–5000 characters. */
export function LabelAppealForm({ onSubmit }: { onSubmit: (body: string) => Promise<void> }): React.JSX.Element {
  return (
    <AppealBodyForm
      renderBody={(p) => <Textarea data-testid="label-appeal-body" {...p} />}
      renderSubmit={(p) => <Button data-testid="label-appeal-submit" {...p} />}
      onSubmit={onSubmit}
      text={{
        title: t("safety.label.appealTitle"),
        description: t("safety.label.appealDescription"),
        body: t("safety.label.appealBody"),
        hint: t("safety.label.appealBodyHint", { min: APPEAL_BODY_MIN, max: APPEAL_BODY_MAX }),
        submit: t("safety.label.appealSubmit"),
        done: t("safety.label.appealDone"),
        failed: t("safety.label.appealFailed"),
      }}
    />
  );
}

/** `account-appeal-dialog`: why the account action is wrong, 10–5000 characters. */
export function AccountAppealForm({ onSubmit }: { onSubmit: (body: string) => Promise<void> }): React.JSX.Element {
  return (
    <AppealBodyForm
      renderBody={(p) => <Textarea data-testid="account-appeal-body" {...p} />}
      renderSubmit={(p) => <Button data-testid="account-appeal-submit" {...p} />}
      onSubmit={onSubmit}
      text={{
        title: t("appeals.account.appealTitle"),
        description: t("appeals.account.appealDescription"),
        body: t("appeals.account.appealBody"),
        hint: t("appeals.account.appealBodyHint", { min: APPEAL_BODY_MIN, max: APPEAL_BODY_MAX }),
        submit: t("appeals.account.appealSubmit"),
        done: t("appeals.account.appealDone"),
        failed: t("appeals.account.appealFailed"),
      }}
    />
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

export interface AccountActionListProps {
  /** `null` while loading. */
  actions: readonly AccountActionDto[] | null;
  appeals: readonly AppealDto[];
  onAppeal: (action: AccountActionDto, body: string) => Promise<void>;
}

/** "Account actions" on `/settings/appeals`: each `account-action`, its state and its appeal. */
export function AccountActionList({ actions, appeals, onAppeal }: AccountActionListProps): React.JSX.Element {
  const [appealing, setAppealing] = React.useState<AccountActionDto | null>(null);
  let content: React.ReactNode;
  if (actions === null)
    content = (
      <SkeletonGroup label={t("appeals.account.loading")}>
        <SkeletonText lines={2} />
      </SkeletonGroup>
    );
  else if (actions.length === 0)
    content = (
      <EmptyState
        icon={UserShield01Icon}
        title={t("appeals.account.empty")}
        description={t("appeals.account.emptyHint")}
        headingLevel={3}
      />
    );
  else
    content = (
      <ItemGroup>
        {actions.map((action) => {
          const reversed = action.reversedAt !== null;
          const pending = hasOpenAccountAppeal(action, appeals);
          return (
            <Item
              key={action.id}
              data-testid="account-action"
              data-action-id={action.id}
              data-action={action.action}
              data-reversed={reversed ? "true" : "false"}
              variant="outline"
              size="sm"
            >
              <ItemContent>
                <ItemTitle>{accountActionLabel(action.action)}</ItemTitle>
                <ItemDescription>
                  {t("appeals.account.recorded")} <RelativeTime date={action.createdAt} />
                </ItemDescription>
              </ItemContent>
              <ItemActions className="flex-col items-end gap-1">
                {reversed ? (
                  // The database pairs `reversed_at` with a reason (check constraint).
                  action.reversedReason && (
                    <StatusBadge tone="success">{reversalLabel(action.reversedReason)}</StatusBadge>
                  )
                ) : (
                  <StatusBadge tone="warning">{t("appeals.account.inEffect")}</StatusBadge>
                )}
                {reversed && action.reversedAt && (
                  <RelativeTime date={action.reversedAt} className="text-xs text-muted-foreground" />
                )}
                {!reversed && pending && <StatusBadge tone="info">{t("appeals.account.appealPending")}</StatusBadge>}
                {/* Only an action that can still be appealed carries the open control (e7-selectors). */}
                {!reversed && !pending && (
                  <Button
                    data-testid="account-action-appeal-open"
                    variant="outline"
                    size="sm"
                    onClick={() => setAppealing(action)}
                  >
                    {t("appeals.account.appeal")}
                  </Button>
                )}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    );
  return (
    <Section heading={t("appeals.account.title")} description={t("appeals.account.intro")}>
      {content}
      <Dialog open={appealing !== null} onOpenChange={(open) => !open && setAppealing(null)}>
        {appealing && (
          <DialogContent data-testid="account-appeal-dialog" data-action-id={appealing.id} className="sm:max-w-lg">
            <AccountAppealForm
              onSubmit={async (body) => {
                await onAppeal(appealing, body);
                setAppealing(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </Section>
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
            data-kind={appeal.kind}
            data-subject-type={appeal.subjectType}
            data-status={appeal.status}
            variant="outline"
            size="sm"
          >
            <ItemContent>
              <ItemTitle>{appealSubjectLabel(appeal.subjectType)}</ItemTitle>
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
  /** A new appeal from elsewhere on the page (an account action) joins the list. */
  add: (appeal: AppealDto) => void;
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
  const add = (created: AppealDto) => setAppeals((list) => [created, ...(list ?? [])]);
  return {
    labels,
    appeals,
    failed,
    add,
    appeal: async (label, body) => {
      add(await clientRef.current.appealLabel(label.id, body));
    },
  };
}

/** `appeals.accountActions`, loaded once; `null` while loading. */
export function useAccountActions(client: AccountActionsClient): {
  actions: AccountActionDto[] | null;
  failed: boolean;
} {
  const [actions, setActions] = React.useState<AccountActionDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const clientRef = React.useRef(client);
  React.useEffect(() => {
    let live = true;
    clientRef.current
      .list()
      .then((a) => {
        if (live) setActions(a);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return { actions, failed };
}

/** `/settings/appeals` content: label notices on top, account actions, then every appeal. */
export function MyAppeals({
  client = appealsClient(),
  accountClient = accountActionsClient(),
}: {
  client?: AppealsClient;
  accountClient?: AccountActionsClient;
}): React.JSX.Element {
  const data = useAppeals(client);
  const account = useAccountActions(accountClient);
  if (data.failed) return <FormError>{t("safety.appeals.loadFailed")}</FormError>;
  return (
    <>
      <LabelNotices labels={data.labels ?? []} appeals={data.appeals ?? []} onAppeal={data.appeal} />
      {account.failed ? (
        <FormError>{t("appeals.account.loadFailed")}</FormError>
      ) : (
        <AccountActionList
          actions={data.appeals === null ? null : account.actions}
          appeals={data.appeals ?? []}
          onAppeal={async (action, body) => data.add(await accountClient.appeal(action.id, body))}
        />
      )}
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
