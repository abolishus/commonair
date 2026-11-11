// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → Privacy & data, the "Download your data" section (D7.4, account-admin.md P6): one
 * row per kind (account, channel, the moving bundle) with the newest export's status and, while
 * it is ready, its download. The list is polled every 5 s while an export is queued or running.
 * The delete dialog reads the same state, so "Download now" there shows up here too.
 */
import { RelativeTime, StatusBadge, formatBytes, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { exportStatusTone } from "@commonair/ui/blocks/privacy";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api, errorCode } from "../lib/api.ts";
import { fillNode } from "../lib/fill.tsx";
import {
  EXPORTS_POLL_MS,
  exportKindOptions,
  exportKinds,
  exportRows,
  shouldPollExports,
  withExport,
  type ExportJobDto,
  type RequestableExportKind,
} from "../lib/privacy.ts";
import { browserPollEnv, pollWhileVisible, type PollEnv } from "../lib/stream-health.ts";

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

export interface ExportsState {
  /** null until the first list arrives. */
  exports: ExportJobDto[] | null;
  failed: boolean;
  load: () => Promise<void>;
  /** Request an export of `kind`; throws what the API refused with. */
  request: (kind: RequestableExportKind) => Promise<void>;
}

/** `me.exports.list`, polled while an export is queued or running; newer answers win. */
export function useExports({ pollEnv, enabled = true }: { pollEnv?: PollEnv; enabled?: boolean } = {}): ExportsState {
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
    if (!enabled) return;
    const s = seq.current;
    void load();
    return () => {
      s.minApplied = s.next;
    };
  }, [load, enabled]);

  const polling = enabled && exports !== null && shouldPollExports(exports);
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
      pollEnv ?? browserPollEnv(),
    );
  }, [polling, load, pollEnv]);

  const request = React.useCallback(async (kind: RequestableExportKind): Promise<void> => {
    const job = await api().me.exports.create({ kind });
    seq.current.minApplied = seq.current.next;
    setExports((list) => withExport(list, job));
    toast.success(t("privacy.export.requestedToast"));
  }, []);

  return { exports, failed, load, request };
}

/** What a refused request means for the member (a rate limit reloads the list, which shows the cooldown). */
export function onExportError(state: Pick<ExportsState, "load">, err: unknown): void {
  if (errorCode(err) === "RATE_LIMITED") {
    toast.error(t("privacy.export.rateLimited"));
    void state.load();
  } else toastActionError(err, t("privacy.export.failed"));
}

/**
 * Download your data: account and channel exports are requested here; the moving bundle is made
 * on the studio's Move page (`portability.bundle.create`), so its row links there.
 */
export function ExportSection({
  hasChannel,
  now = Date.now,
  pollEnv,
  state: shared,
}: {
  hasChannel: boolean;
  now?: () => number;
  /** Tests pass a fake clock and visibility; the browser's otherwise. */
  pollEnv?: PollEnv;
  /** The page's shared state (the delete dialog reads it too); without it the section loads its own. */
  state?: ExportsState;
}): React.JSX.Element {
  const own = useExports({ pollEnv, enabled: shared === undefined });
  const state = shared ?? own;
  const { locale } = useLocale();
  const [pending, setPending] = React.useState<string | null>(null);

  if (state.exports === null && state.failed)
    return (
      <LoadError
        testId="export-load-error"
        message={t("privacy.export.loadFailed")}
        onRetry={() => void state.load()}
      />
    );

  const nowMs = now();
  const options = exportKindOptions(exportKinds(hasChannel), state.exports, nowMs);
  const rows = state.exports ? exportRows(state.exports, nowMs) : null;
  const latest = (kind: string) => rows?.find((r) => r.kind === kind) ?? null;
  const request = async (kind: RequestableExportKind) => {
    setPending(kind);
    try {
      await state.request(kind);
    } catch (err) {
      onExportError(state, err);
    } finally {
      setPending(null);
    }
  };

  const status = (row: NonNullable<ReturnType<typeof latest>>) => (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge tone={exportStatusTone(row.status)}>{row.statusLabel}</StatusBadge>
      <span>{fillNode(t("privacy.export.requested"), "time", <RelativeTime date={row.createdAt} />)}</span>
      {row.sizeBytes !== null ? (
        <span className="tabular-nums" data-size-bytes={row.sizeBytes}>
          {formatBytes(row.sizeBytes, locale)}
        </span>
      ) : null}
      {row.status === "ready" && row.expiresAt ? (
        <span>{fillNode(t("privacy.export.expires"), "time", <RelativeTime date={row.expiresAt} />)}</span>
      ) : null}
    </span>
  );

  return (
    <SettingsSection
      data-testid="privacy-download"
      title={t("d7Settings.privacy.download.title")}
      description={t("privacy.export.intro")}
    >
      {options.map((option) => {
        const row = latest(option.kind);
        const kind = option.kind as RequestableExportKind;
        return (
          <SettingsRow
            key={option.kind}
            {...(row
              ? {
                  "data-testid": "export-row",
                  "data-export-id": row.id,
                  "data-kind": row.kind,
                  "data-status": row.status,
                }
              : {})}
            label={option.label}
            hint={
              <span className="flex flex-col gap-1">
                <span>{option.description}</span>
                {rows === null ? null : row ? status(row) : <span>{t("d7Settings.privacy.download.none")}</span>}
                {option.cooldownUntil ? (
                  <span data-cooldown-until={option.cooldownUntil}>
                    {fillNode(t("privacy.export.cooldown"), "time", <RelativeTime date={option.cooldownUntil} />)}
                  </span>
                ) : null}
              </span>
            }
          >
            {row?.downloadUrl ? (
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                // A signed link: never leak it through Referer.
                render={
                  <a
                    href={row.downloadUrl}
                    rel="noreferrer noopener"
                    download
                    aria-label={t("privacy.export.download")}
                  />
                }
                data-testid="export-download"
              >
                {t("privacy.export.download")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="export-request"
              data-kind={option.kind}
              disabled={option.cooldownUntil !== null || pending !== null}
              aria-busy={pending === option.kind || undefined}
              onClick={() => void request(kind)}
            >
              {t("privacy.export.request")}
            </Button>
          </SettingsRow>
        );
      })}
      {hasChannel ? (
        <SettingsRow
          label={t("privacy.export.kind.bundle")}
          hint={
            <span className="flex flex-col gap-1">
              <span>{t("d7Settings.privacy.download.bundleHint")}</span>
              {(() => {
                const row = latest("bundle");
                return row ? status(row) : null;
              })()}
            </span>
          }
        >
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link data-testid="export-bundle-link" to="/move" />}
          >
            {t("d7Settings.privacy.download.bundleAction")}
          </Button>
        </SettingsRow>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <p data-testid="export-empty" className="px-4 py-3 text-sm text-muted-foreground sm:px-6">
          {t("privacy.export.emptyHint")}
        </p>
      ) : null}
    </SettingsSection>
  );
}
