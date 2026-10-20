// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, SkeletonText } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { FieldGroup } from "@commonair/ui/components/field";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { IngestServerUrl, NewStreamKey } from "../../components/ingest-values.tsx";
import { StreamHealthCard } from "../../components/stream-health-card.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_studio/dashboard")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = me.channelSlug ?? me.username;
  return (
    <PageContainer width="narrow" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("dashboard.title")}
        actions={
          <>
            <Button
              data-testid="revenue-link"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/revenue" />}
            >
              {t("dashboard.revenue")}
            </Button>
            <Button
              data-testid="relays-link"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/relays" />}
            >
              {t("dashboard.relays")}
            </Button>
            <Button
              data-testid="channel-link"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/$channel" params={{ channel }} />}
            >
              {t("dashboard.viewChannel")}
            </Button>
          </>
        }
      />
      <StreamHealthCard key={channel} channel={channel} />
      <StreamSetup channel={channel} />
    </PageContainer>
  );
}

interface Ingest {
  rtmpUrl: string;
  activeKeyPrefix: string | null;
}

function StreamSetup({ channel }: { channel: string }): React.JSX.Element {
  const { config } = useBootstrap();
  const [ingest, setIngest] = React.useState<Ingest | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [rotating, setRotating] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api()
      .stream.ingest({ channel })
      .then((info) => {
        if (!cancelled) setIngest({ rtmpUrl: info.rtmpUrl, activeKeyPrefix: info.activeKeyPrefix });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const rotate = async () => {
    setRotating(true);
    try {
      const created = await api().stream.rotateKey({ channel });
      setNewKey(created.key);
      setIngest((prev) => (prev ? { ...prev, activeKeyPrefix: created.prefix } : prev));
      toast.success(t("dashboard.keyRotated"));
    } finally {
      setRotating(false);
    }
  };

  const serverUrl = ingest?.rtmpUrl ?? config.ingestRtmpUrl;
  const rotateButton = (
    <Button data-testid="stream-key-rotate" variant="outline" disabled={!ingest || rotating}>
      {ingest?.activeKeyPrefix ? t("dashboard.rotateKey") : t("dashboard.createKey")}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("dashboard.streamSetup")}</CardTitle>
        <CardDescription>{t("dashboard.streamSetupHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {loadError && <FormError>{t("dashboard.loadFailed")}</FormError>}
          <IngestServerUrl value={serverUrl} />
          {ingest ? (
            <KeyValueList
              rows={[
                {
                  term: t("dashboard.activeKey"),
                  value: (
                    <>
                      <span data-testid="stream-key-prefix">{ingest.activeKeyPrefix ?? ""}</span>
                      {ingest.activeKeyPrefix ? t("dashboard.keyTruncated") : t("dashboard.noKey")}
                    </>
                  ),
                },
              ]}
            />
          ) : (
            <SkeletonText lines={1} />
          )}
          {newKey && <NewStreamKey value={newKey} />}
          <div>
            {ingest?.activeKeyPrefix ? (
              <ConfirmDialog
                trigger={rotateButton}
                title={t("dashboard.rotateConfirmTitle")}
                description={t("dashboard.rotateConfirmBody")}
                confirmLabel={t("dashboard.rotateKey")}
                variant="destructive"
                onConfirm={rotate}
                onError={() => toast.error(t("dashboard.rotateFailed"))}
              />
            ) : (
              React.cloneElement(rotateButton, {
                onClick: () => void rotate().catch(() => toast.error(t("dashboard.rotateFailed"))),
              })
            )}
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
