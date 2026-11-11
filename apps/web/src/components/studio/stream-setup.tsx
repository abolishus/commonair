// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stream settings' "Stream setup" card: the ingest server URL and the stream key (create, rotate
 * with confirmation, shown once). Moved from the dashboard to `/dashboard/settings` (F21).
 */
import { ConfirmDialog, SkeletonText } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { FieldGroup } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { IngestServerUrl, NewStreamKey } from "../ingest-values.tsx";

interface Ingest {
  rtmpUrl: string;
  activeKeyPrefix: string | null;
}

export function StreamSetup({ channel }: { channel: string }): React.JSX.Element {
  const { config } = useBootstrap();
  const [ingest, setIngest] = React.useState<Ingest | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  // Retry bumps this to load again.
  const [attempt, setAttempt] = React.useState(0);
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
  }, [channel, attempt]);

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
          {loadError && (
            <SectionLoadError
              section={t("dashboard.streamSetup")}
              load={{
                reload: () => {
                  setLoadError(false);
                  setAttempt((n) => n + 1);
                },
              }}
              headingLevel={3}
              data-testid="stream-setup-error"
              retryTestId="stream-setup-retry"
            />
          )}
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
