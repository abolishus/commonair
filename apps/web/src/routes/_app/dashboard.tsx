// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, IconButton, SkeletonText } from "@commonair/ui";
import { Button, buttonVariants } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { StreamHealthCard } from "../../components/stream-health-card.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/dashboard")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = me.channelSlug ?? me.username;
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-xl font-semibold">{t("dashboard.title")}</h1>
        <Link
          data-testid="channel-link"
          to="/$channel"
          params={{ channel }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t("dashboard.viewChannel")}
        </Link>
      </div>
      <StreamHealthCard key={channel} channel={channel} />
      <StreamSetup channel={channel} />
    </section>
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

  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      toast.success(t("dashboard.keyCopied"));
    } catch {
      toast.error(t("dashboard.copyFailed"));
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
      <CardContent className="flex flex-col gap-4 text-xs">
        {loadError && <FormError>{t("dashboard.loadFailed")}</FormError>}
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t("dashboard.serverUrl")}</span>
          <code data-testid="stream-server-url" className="break-all bg-muted px-2 py-1">
            {serverUrl}
          </code>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t("dashboard.activeKey")}</span>
          {ingest ? (
            <code className="bg-muted px-2 py-1">
              <span data-testid="stream-key-prefix">{ingest.activeKeyPrefix ?? ""}</span>
              {ingest.activeKeyPrefix ? t("dashboard.keyTruncated") : t("dashboard.noKey")}
            </code>
          ) : (
            <SkeletonText lines={1} />
          )}
        </div>
        {newKey && (
          <div className="flex flex-col gap-1" aria-live="polite">
            <span className="text-muted-foreground">{t("dashboard.newKey")}</span>
            <div className="flex items-center gap-2">
              <code data-testid="stream-key" className="min-w-0 flex-1 break-all bg-muted px-2 py-1">
                {newKey}
              </code>
              <IconButton
                data-testid="stream-key-copy"
                label={t("dashboard.copyKey")}
                icon={Copy01Icon}
                variant="outline"
                onClick={() => void copyKey()}
              />
            </div>
            <span className="text-muted-foreground">{t("dashboard.newKeyOnce")}</span>
          </div>
        )}
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
      </CardContent>
    </Card>
  );
}
