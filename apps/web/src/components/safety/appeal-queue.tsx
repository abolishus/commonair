// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
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

/** `/admin/appeals`: open appeals, each resolvable in place. */
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

export function AppealQueueList({
  appeals,
  onResolve,
}: {
  appeals: AppealDto[] | null;
  onResolve: (appeal: AppealDto, status: "upheld" | "overturned", resolution: string) => Promise<void>;
}): React.JSX.Element {
  if (appeals === null)
    return (
      <SkeletonGroup label={t("safety.appealq.loading")}>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  if (appeals.length === 0)
    return <EmptyState icon={CheckmarkCircle02Icon} title={t("safety.appealq.empty")} headingLevel={3} />;
  return (
    <div className="flex flex-col gap-4">
      {appeals.map((appeal) => (
        <AppealCard key={appeal.id} appeal={appeal} onResolve={(s, r) => onResolve(appeal, s, r)} />
      ))}
    </div>
  );
}

function AppealCard({
  appeal,
  onResolve,
}: {
  appeal: AppealDto;
  onResolve: (status: "upheld" | "overturned", resolution: string) => Promise<void>;
}): React.JSX.Element {
  const [status, setStatus] = React.useState<"upheld" | "overturned" | "">("");
  const [resolution, setResolution] = React.useState("");
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
    <Card
      size="sm"
      data-testid="appealq-item"
      data-appeal-id={appeal.id}
      data-kind={appeal.kind}
      data-subject-type={appeal.subjectType}
      data-status={appeal.status}
    >
      <CardHeader>
        <CardTitle>{appealSubjectLabel(appeal.subjectType)}</CardTitle>
        <CardAction className="flex items-center gap-2">
          <StatusBadge tone="neutral">{appealKindLabel(appeal.kind)}</StatusBadge>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          <RelativeTime date={appeal.createdAt} className="text-xs text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <p className="text-sm whitespace-pre-wrap">{appeal.body}</p>
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
                  if (v === "upheld" || v === "overturned") setStatus(v);
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
                  onChange={(e) => setResolution(e.currentTarget.value)}
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
      </CardContent>
    </Card>
  );
}
