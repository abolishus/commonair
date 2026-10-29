// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/settings/connections`: every app the member authorized (`developer.grants.list`), what each
 * may do in plain words, and a confirmed revoke (`developer.grants.revoke`), which also cuts the
 * app's chat bots and event subscriptions at once (ADR 0027 §1).
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardHeader } from "@commonair/ui/components/card";
import { Skeleton } from "@commonair/ui";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { PlugSocketIcon, Unlink02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { fillNode } from "../../lib/fill.tsx";
import { AppOwner } from "./app-owner.tsx";
import { ScopeList } from "./scope-list.tsx";
import type { GrantDto, OAuthClient } from "./shared.ts";

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; grants: GrantDto[] };

export function Connections({ client }: { client: OAuthClient }): React.JSX.Element {
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    client.grants
      .list()
      .then((grants) => {
        if (live) setLoad({ kind: "loaded", grants });
      })
      .catch(() => {
        if (live) setLoad({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [client, attempt]);

  const revoke = async (grant: GrantDto) => {
    await client.grants.revoke({ appId: grant.app.id });
    setLoad((l) => (l.kind === "loaded" ? { ...l, grants: l.grants.filter((g) => g.app.id !== grant.app.id) } : l));
    toast.success(t("oauth.connections.revoked", { app: grant.app.name }));
  };

  return (
    <PageContainer data-testid="connections" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("oauth.connections.pageTitle")}
        description={
          load.kind === "loaded" && load.grants.length > 0
            ? t("oauth.connections.introWithCount", { count: load.grants.length })
            : t("oauth.connections.intro")
        }
      />
      {load.kind === "loading" && <ConnectionsSkeleton />}
      {load.kind === "failed" && (
        <AlertCallout
          data-testid="connections-load-error"
          tone="danger"
          live
          description={t("oauth.connections.loadFailed")}
          action={
            <Button
              data-testid="connections-retry"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoad({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              {t("oauth.connections.retry")}
            </Button>
          }
        />
      )}
      {load.kind === "loaded" &&
        (load.grants.length === 0 ? (
          <EmptyState
            data-testid="connections-empty"
            icon={PlugSocketIcon}
            title={t("oauth.connections.empty")}
            description={t("oauth.connections.emptyHint")}
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {load.grants.map((grant) => (
              <li key={grant.app.id}>
                <ConnectionRow grant={grant} onRevoke={() => revoke(grant)} />
              </li>
            ))}
          </ul>
        ))}
    </PageContainer>
  );
}

function ConnectionsSkeleton(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("oauth.connections.loading")} className="flex flex-col gap-4">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-1/3" />
          </CardHeader>
          <CardContent>
            <SkeletonText lines={3} />
          </CardContent>
        </Card>
      ))}
    </SkeletonGroup>
  );
}

export function ConnectionRow({
  grant,
  onRevoke,
}: {
  grant: GrantDto;
  onRevoke: () => Promise<void>;
}): React.JSX.Element {
  const { app } = grant;
  const listId = React.useId();
  return (
    <Card
      data-testid="connection"
      data-app-id={app.id}
      data-client-id={app.clientId}
      data-scopes={grant.scopes.join(" ")}
    >
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold break-words">{app.name}</h2>
          {app.description && <p className="text-sm break-words text-muted-foreground">{app.description}</p>}
          <AppOwner owner={app.owner} testId="connection-owner" />
        </div>
        <ConfirmDialog
          trigger={
            <Button
              data-testid="connection-revoke"
              variant="destructive"
              size="sm"
              aria-label={t("oauth.connections.revokeLabel", { app: app.name })}
              className="self-start"
            >
              <HugeiconsIcon icon={Unlink02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("oauth.connections.revoke")}
            </Button>
          }
          variant="destructive"
          title={t("oauth.connections.revokeTitle", { app: app.name })}
          description={t("oauth.connections.revokeBody", { app: app.name })}
          confirmLabel={t("oauth.connections.revoke")}
          onConfirm={onRevoke}
          onError={(err) => toastActionError(err, t("oauth.connections.revokeFailed"))}
          contentProps={{ "data-testid": "connection-revoke-dialog" }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p id={listId} className="text-sm font-medium">
          {t("oauth.connections.permissions")}
        </p>
        <ScopeList scopes={grant.scopes} labelledBy={listId} itemTestId="connection-scope" detailed={false} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{fillNode(t("oauth.connections.authorized"), "when", <RelativeTime date={grant.authorizedAt} />)}</span>
          <span>
            {grant.lastUsedAt
              ? fillNode(t("oauth.connections.lastUsed"), "when", <RelativeTime date={grant.lastUsedAt} />)
              : t("oauth.connections.neverUsed")}
          </span>
        </p>
      </CardContent>
    </Card>
  );
}
