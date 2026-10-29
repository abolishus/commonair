// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/developer/apps/$appId`: one app's credentials and redirect URIs, editing, secret rotation
 * (the new secret once, in `devapp-secret`) and deletion; below, its webhook subscriptions.
 */
import { ConfirmDialog, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Delete02Icon, Key01Icon, PencilEdit01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { NotFoundState } from "../money/not-found.tsx";
import { useLoad } from "../money/use-load.ts";
import { StudioSection, fillNodes } from "../interact-studio/shared.tsx";
import { AppFormDialog, type AppEditing } from "./app-form.tsx";
import type { DeveloperClient, OAuthAppDto, OAuthAppSecretDto } from "./client.ts";
import {
  type AppDraft,
  type AppField,
  type FieldErrors,
  SUSPENSION_REASON_KEYS,
  appInput,
  developerError,
} from "./model.ts";
import { CopyButton, LoadError, SecretDialog } from "./shared.tsx";
import { SubscriptionsPanel } from "./subscriptions.tsx";

export function DeveloperAppPage({
  appId,
  client,
  onDeleted,
}: {
  appId: string;
  client: DeveloperClient;
  /** After a delete (the route goes back to `/developer`). */
  onDeleted: () => void;
}): React.JSX.Element {
  const loaded = useLoad(
    `developer:app:${appId}`,
    async () => (await client.apps.list()).find((a) => a.id === appId) ?? null,
  );
  const [updated, setUpdated] = React.useState<OAuthAppDto | null>(null);
  if (loaded.data === null && loaded.failed)
    return <LoadError message={t("developer.app.loadFailed")} onRetry={loaded.reload} />;
  if (loaded.data === null)
    return (
      <SkeletonGroup label={t("developer.loading")}>
        <SkeletonText lines={6} />
      </SkeletonGroup>
    );
  const found = loaded.data;
  if (!found) return <NotFoundState />;
  const app = updated?.id === found.id ? updated : found;
  return (
    <div className="flex flex-col gap-6">
      <AppHeader app={app} client={client} onUpdated={setUpdated} onDeleted={onDeleted} />
      <SubscriptionsPanel app={app} client={client} />
    </div>
  );
}

function AppHeader({
  app,
  client,
  onUpdated,
  onDeleted,
}: {
  app: OAuthAppDto;
  client: DeveloperClient;
  onUpdated: (app: OAuthAppDto) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = React.useState<AppEditing>(null);
  const [secret, setSecret] = React.useState<OAuthAppSecretDto | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const suspended = app.suspended !== null;

  const save = async (draft: AppDraft): Promise<FieldErrors<AppField> | null> => {
    const checked = appInput({ ...draft, confidential: app.confidential });
    if (!checked.ok) return checked.errors;
    const { name, description, redirectUris } = checked.input;
    const next = await client.apps.update({ id: app.id, name, description, redirectUris });
    onUpdated(next);
    setEditing(null);
    toast.success(t("developer.app.saved", { name: next.name }));
    return null;
  };

  const rotate = async (): Promise<void> => {
    setFailure(null);
    const issued = await client.apps.rotateSecret({ id: app.id });
    setSecret(issued);
  };

  const remove = async (): Promise<void> => {
    setFailure(null);
    await client.apps.remove({ id: app.id });
    toast.success(t("developer.app.deleted", { name: app.name }));
    onDeleted();
  };

  return (
    <div
      data-testid="devapp"
      data-app-id={app.id}
      data-client-id={app.clientId}
      data-confidential={app.confidential ? "true" : "false"}
      data-suspended={suspended ? "true" : "false"}
      className="flex flex-col gap-4"
    >
      {app.suspended ? (
        <AlertCallout
          tone="danger"
          title={t("developer.app.suspendedTitle")}
          description={t("developer.app.suspendedBody", { reason: t(SUSPENSION_REASON_KEYS[app.suspended.reason]) })}
        />
      ) : null}
      <StudioSection
        icon={SourceCodeIcon}
        title={app.name}
        description={app.description === "" ? t("developer.app.noDescription") : app.description}
      >
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-4">
          <dt className="text-muted-foreground">{t("developer.app.clientId")}</dt>
          <dd className="flex min-w-0 items-center gap-2 sm:col-span-3">
            <code data-testid="devapp-client-id" className="min-w-0 break-all">
              {app.clientId}
            </code>
            <CopyButton value={app.clientId} label={t("developer.app.copyClientId")} />
          </dd>
          <dt className="text-muted-foreground">{t("developer.app.type")}</dt>
          <dd className="flex flex-col gap-1 sm:col-span-3">
            <span>
              <StatusBadge tone="neutral">
                {app.confidential ? t("developer.app.kind.confidential") : t("developer.app.kind.public")}
              </StatusBadge>
            </span>
            <span className="text-xs text-muted-foreground">
              {app.confidential ? t("developer.app.confidentialHint") : t("developer.app.publicHint")}
            </span>
          </dd>
          <dt className="text-muted-foreground">{t("developer.app.redirects")}</dt>
          <dd className="min-w-0 sm:col-span-3">
            <ul className="flex flex-col gap-1">
              {app.redirectUris.map((uri) => (
                <li key={uri}>
                  <code className="text-xs break-all">{uri}</code>
                </li>
              ))}
            </ul>
          </dd>
          {app.confidential ? (
            <>
              <dt className="text-muted-foreground">{t("developer.secret.label")}</dt>
              <dd className="text-muted-foreground sm:col-span-3">
                {app.secretRotatedAt
                  ? fillNodes(t("developer.app.secretRotated"), { time: <RelativeTime date={app.secretRotatedAt} /> })
                  : fillNodes(t("developer.app.secretIssued"), { time: <RelativeTime date={app.createdAt} /> })}
              </dd>
            </>
          ) : null}
        </dl>
        {failure ? (
          <p role="alert" className="text-sm break-words text-destructive">
            {failure}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="devapp-edit"
            disabled={suspended}
            onClick={() => setEditing({ mode: "edit", app })}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("developer.app.edit")}
          </Button>
          {app.confidential ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" size="sm" data-testid="devapp-rotate" disabled={suspended}>
                  <HugeiconsIcon icon={Key01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                  {t("developer.app.rotate")}
                </Button>
              }
              title={t("developer.app.rotateTitle", { name: app.name })}
              description={t("developer.app.rotateBody")}
              confirmLabel={t("developer.app.rotateConfirm")}
              onConfirm={rotate}
              onError={(err) => setFailure(developerError(err, "developer.app.rotateFailed"))}
            />
          ) : null}
          <ConfirmDialog
            trigger={
              <Button type="button" variant="destructive" size="sm" data-testid="devapp-delete">
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("developer.app.delete")}
              </Button>
            }
            variant="destructive"
            icon={Delete02Icon}
            title={t("developer.app.deleteTitle", { name: app.name })}
            description={t("developer.app.deleteBody")}
            confirmLabel={t("developer.app.deleteConfirm")}
            onConfirm={remove}
            onError={(err) => setFailure(developerError(err, "developer.app.deleteFailed"))}
          />
        </div>
      </StudioSection>
      <AppFormDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={save}
        errorMessage={(err) => developerError(err, "developer.app.saveFailed")}
      />
      <SecretDialog secret={secret} onDone={() => setSecret(null)} />
    </div>
  );
}
