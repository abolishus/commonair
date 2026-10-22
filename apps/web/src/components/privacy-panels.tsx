// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import {
  DeletionPanel,
  ExportPanel,
  type DeletionPanelLabels,
  type ExportPanelLabels,
} from "@commonair/ui/blocks/privacy";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api, errorCode } from "../lib/api.ts";
import { fillNode } from "../lib/fill.tsx";
import {
  EXPORTS_POLL_MS,
  deletionView,
  exportKindOptions,
  exportKinds,
  exportRows,
  shouldPollExports,
  withExport,
  type DeletionRequestDto,
  type ExportJobDto,
  type ExportKind,
} from "../lib/privacy.ts";
import { browserPollEnv, pollWhileVisible } from "../lib/stream-health.ts";
import { useLoad } from "./money/use-load.ts";

function exportLabels(): ExportPanelLabels {
  return {
    title: t("privacy.export.title"),
    description: t("privacy.export.intro"),
    request: t("privacy.export.request"),
    cooldown: (time) => fillNode(t("privacy.export.cooldown"), "time", time),
    listLabel: t("privacy.export.list"),
    emptyTitle: t("privacy.export.empty"),
    emptyDescription: t("privacy.export.emptyHint"),
    requested: (time) => fillNode(t("privacy.export.requested"), "time", time),
    expires: (time) => fillNode(t("privacy.export.expires"), "time", time),
    download: t("privacy.export.download"),
  };
}

function deletionLabels(): DeletionPanelLabels {
  return {
    title: t("privacy.deletion.title"),
    description: t("privacy.deletion.intro"),
    request: t("privacy.deletion.request"),
    confirmTitle: t("privacy.deletion.confirmTitle"),
    confirmDescription: t("privacy.deletion.confirmBody"),
    confirmLabel: t("privacy.deletion.confirm"),
    confirmUsername: t("privacy.deletion.confirmUsername"),
    confirmUsernameHint: (username) => t("privacy.deletion.confirmUsernameHint", { username }),
    scheduled: (date) => fillNode(t("privacy.deletion.scheduled"), "date", date),
    canceled: t("privacy.deletion.canceled"),
    cancel: t("privacy.deletion.cancel"),
  };
}

function LoadError({ testId, message, onRetry }: { testId: string; message: string; onRetry: () => void }) {
  return (
    <AlertCallout
      data-testid={testId}
      tone="danger"
      live
      description={message}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

/**
 * Data export (`me.exports.*`): one request button per kind, the caller's exports, polled every
 * 5 s while one is queued or running. The download link is the API's presigned URL, shown only
 * while the export is ready and unexpired.
 */
export function ExportSection({ hasChannel, now = Date.now }: { hasChannel: boolean; now?: () => number }) {
  const [exports, setExports] = React.useState<ExportJobDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const seq = React.useRef({ next: 0, minApplied: 0 });

  const load = React.useCallback((): Promise<void> => {
    const s = seq.current;
    const id = s.next++;
    return api()
      .me.exports.list()
      .then((list) => {
        if (id < s.minApplied) return;
        s.minApplied = id;
        setExports(list);
        setFailed(false);
      })
      .catch(() => {
        if (id >= s.minApplied) setFailed(true);
      });
  }, []);

  React.useEffect(() => {
    const s = seq.current;
    void load();
    return () => {
      s.minApplied = s.next;
    };
  }, [load]);

  const polling = exports !== null && shouldPollExports(exports);
  React.useEffect(() => {
    if (!polling) return;
    let inFlight = false;
    let first = true;
    return pollWhileVisible(
      () => {
        if (first) {
          first = false;
          return;
        }
        if (inFlight) return;
        inFlight = true;
        void load().finally(() => {
          inFlight = false;
        });
      },
      EXPORTS_POLL_MS,
      browserPollEnv(),
    );
  }, [polling, load]);

  if (exports === null && failed)
    return (
      <LoadError testId="export-load-error" message={t("privacy.export.loadFailed")} onRetry={() => void load()} />
    );

  const request = async (kind: string): Promise<void> => {
    const chosen = exportKinds(hasChannel).find((k) => k === kind) as ExportKind | undefined;
    if (!chosen) return;
    const job = await api().me.exports.create({ kind: chosen });
    seq.current.minApplied = seq.current.next;
    setExports((list) => withExport(list, job));
    toast.success(t("privacy.export.requestedToast"));
  };
  const nowMs = now();

  return (
    <ExportPanel
      kinds={exportKindOptions(exportKinds(hasChannel), exports, nowMs)}
      exports={exports ? exportRows(exports, nowMs) : null}
      labels={exportLabels()}
      onRequest={request}
      onError={(err) => {
        if (errorCode(err) === "RATE_LIMITED") {
          toast.error(t("privacy.export.rateLimited"));
          // The list shows which export holds the cooldown, so the button disables itself.
          void load();
        } else toastActionError(err, t("privacy.export.failed"));
      }}
    />
  );
}

/** Account deletion (`me.deletion.*`): request with the typed username, status, cancel. */
export function DeletionSection({ username }: { username: string }) {
  // Wrapped: `me.deletion.get` answers null for "no request", which `useLoad` uses for "not loaded".
  const loaded = useLoad("deletion", async () => ({ request: await api().me.deletion.get() }));
  const [local, setLocal] = React.useState<{ request: DeletionRequestDto | null } | null>(null);
  const current = local ?? loaded.data;

  if (current === null && loaded.failed)
    return (
      <LoadError testId="deletion-load-error" message={t("privacy.deletion.loadFailed")} onRetry={loaded.reload} />
    );

  const request = current?.request ?? null;

  const submit = async (confirmUsername: string): Promise<void> => {
    const scheduled = await api().me.deletion.request({ confirmUsername });
    setLocal({ request: scheduled });
    toast.success(t("privacy.deletion.scheduledToast"));
  };
  const cancel = async (): Promise<void> => {
    await api().me.deletion.cancel();
    setLocal({ request: request ? { ...request, status: "canceled" } : null });
    toast.success(t("privacy.deletion.canceledToast"));
  };

  return (
    <DeletionPanel
      request={deletionView(request)}
      loading={current === null}
      labels={deletionLabels()}
      username={username}
      onRequest={submit}
      onCancel={cancel}
      onError={(err) => toastActionError(err, t("privacy.deletion.failed"))}
    />
  );
}
