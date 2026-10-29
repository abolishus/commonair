// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/developer`: your OAuth apps and the form to register one. A confidential app's secret is shown
 * once, in `devapp-secret`, right after it is created.
 */
import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, ArrowRight01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useLoad } from "../money/use-load.ts";
import { StudioSection, fillNodes } from "../interact-studio/shared.tsx";
import { AppFormDialog, type AppEditing } from "./app-form.tsx";
import type { DeveloperClient, OAuthAppDto, OAuthAppSecretDto } from "./client.ts";
import { type AppDraft, type AppField, type FieldErrors, appInput, developerError } from "./model.ts";
import { LoadError, SecretDialog } from "./shared.tsx";

export function DeveloperAppsPage({ client }: { client: DeveloperClient }): React.JSX.Element {
  const loaded = useLoad("developer:apps", () => client.apps.list());
  const [added, setAdded] = React.useState<OAuthAppDto[]>([]);
  const [editing, setEditing] = React.useState<AppEditing>(null);
  const [secret, setSecret] = React.useState<OAuthAppSecretDto | null>(null);

  const apps = loaded.data ? [...added.filter((a) => !loaded.data?.some((b) => b.id === a.id)), ...loaded.data] : null;

  const create = async (draft: AppDraft): Promise<FieldErrors<AppField> | null> => {
    const checked = appInput(draft);
    if (!checked.ok) return checked.errors;
    const { app, secret: issued } = await client.apps.create(checked.input);
    setAdded((list) => [app, ...list]);
    setEditing(null);
    toast.success(t("developer.app.created", { name: app.name }));
    if (issued) setSecret(issued);
    return null;
  };

  return (
    <div data-testid="devapps" className="flex flex-col gap-6">
      <StudioSection
        icon={SourceCodeIcon}
        title={t("developer.apps.title")}
        description={t("developer.apps.intro")}
        action={
          <Button type="button" size="sm" data-testid="devapp-new" onClick={() => setEditing({ mode: "new" })}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("developer.apps.new")}
          </Button>
        }
      >
        {apps === null && loaded.failed ? (
          <LoadError message={t("developer.apps.loadFailed")} onRetry={loaded.reload} />
        ) : apps === null ? (
          <SkeletonGroup label={t("developer.loading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        ) : apps.length === 0 ? (
          <EmptyState
            data-testid="devapps-empty"
            icon={SourceCodeIcon}
            headingLevel={3}
            title={t("developer.apps.empty")}
            description={t("developer.apps.emptyHint")}
          />
        ) : (
          <ul className="flex flex-col divide-y" aria-label={t("developer.apps.title")}>
            {apps.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </ul>
        )}
      </StudioSection>
      <AppFormDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={create}
        errorMessage={(err) => developerError(err, "developer.app.createFailed")}
      />
      <SecretDialog secret={secret} onDone={() => setSecret(null)} />
    </div>
  );
}

function AppRow({ app }: { app: OAuthAppDto }): React.JSX.Element {
  return (
    <li
      data-testid="devapp-row"
      data-app-id={app.id}
      data-client-id={app.clientId}
      data-suspended={app.suspended ? "true" : "false"}
      className="py-1"
    >
      <Link
        to="/developer/apps/$appId"
        params={{ appId: app.id }}
        className="flex min-w-0 items-center gap-3 rounded-md p-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-words">{app.name}</span>
            <StatusBadge tone="neutral">
              {app.confidential ? t("developer.app.kind.confidential") : t("developer.app.kind.public")}
            </StatusBadge>
            {app.suspended ? <StatusBadge tone="danger">{t("developer.app.suspendedBadge")}</StatusBadge> : null}
          </div>
          <code className="text-xs break-all text-muted-foreground">{app.clientId}</code>
          <span className="text-xs text-muted-foreground">
            {fillNodes(t("developer.app.registered"), { time: <RelativeTime date={app.createdAt} /> })}
          </span>
        </div>
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="size-4 shrink-0 rtl:rotate-180" />
      </Link>
    </li>
  );
}
