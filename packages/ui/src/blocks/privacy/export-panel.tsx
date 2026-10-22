// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Download01Icon, FileExportIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EXPORT_COOLDOWN_SECONDS } from "@commonair/contracts/internal";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { cn } from "@commonair/ui/lib/utils";
import { formatBytes } from "../../lib/format.ts";
import { useLocale } from "../../lib/locale.tsx";
import { EmptyState } from "../../primitives/empty-state.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { SkeletonGroup, SkeletonText } from "../../primitives/skeletons.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";

/** `JOB_STATUSES` → badge tone. */
export function exportStatusTone(status: string): StatusTone {
  if (status === "ready") return "success";
  if (status === "queued" || status === "running") return "info";
  if (status === "failed") return "danger";
  return "neutral";
}

/** Statuses that count against the per-kind cooldown (the API's rule for `me.exports.create`). */
const COOLDOWN_STATUSES = new Set(["queued", "running", "ready"]);

/**
 * When the next export of `kind` may be requested: the newest queued/running/ready export of that
 * kind plus the cooldown, or `null` when one may be requested now. Mirrors the API's
 * `RATE_LIMITED` rule so the button is disabled before the request is refused.
 */
export function exportCooldownUntil(
  exports: readonly { kind: string; status: string; createdAt: string }[],
  kind: string,
  now: Date | number,
  cooldownSeconds: number = EXPORT_COOLDOWN_SECONDS,
): string | null {
  const nowMs = typeof now === "number" ? now : now.getTime();
  let latest = Number.NEGATIVE_INFINITY;
  for (const job of exports) {
    if (job.kind !== kind || !COOLDOWN_STATUSES.has(job.status)) continue;
    const created = Date.parse(job.createdAt);
    if (Number.isFinite(created) && created > latest) latest = created;
  }
  const until = latest + cooldownSeconds * 1000;
  return Number.isFinite(until) && until > nowMs ? new Date(until).toISOString() : null;
}

export interface ExportKindOption {
  /** `EXPORT_KINDS` value; set as `data-kind`. */
  kind: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** From `exportCooldownUntil`: while set, the request button is disabled and says until when. */
  cooldownUntil: string | null;
}

export interface ExportRowData {
  id: string;
  kind: string;
  kindLabel: React.ReactNode;
  /** `JOB_STATUSES` value. */
  status: string;
  statusLabel: string;
  sizeBytes: number | null;
  createdAt: string;
  expiresAt: string | null;
  /** Present only while `ready` and unexpired (the API's rule). */
  downloadUrl: string | null;
}

export interface ExportPanelLabels {
  title: React.ReactNode;
  description?: React.ReactNode;
  request: string;
  /** "Available again {time}". */
  cooldown: (time: React.ReactNode) => React.ReactNode;
  listLabel: string;
  emptyTitle: React.ReactNode;
  emptyDescription?: React.ReactNode;
  /** "Requested {time}". */
  requested: (time: React.ReactNode) => React.ReactNode;
  /** "Link expires {time}". */
  expires: (time: React.ReactNode) => React.ReactNode;
  download: string;
}

export interface ExportPanelProps extends Omit<React.ComponentProps<"div">, "children" | "title" | "onError"> {
  kinds: readonly ExportKindOption[];
  /** The caller's exports, newest first; `null` while loading. */
  exports: readonly ExportRowData[] | null;
  labels: ExportPanelLabels;
  onRequest: (kind: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  locale?: string;
}

/**
 * Data export: one request button per kind (disabled with its reason during the cooldown) and
 * the caller's exports with status, size, expiry and, while ready, the download link. Renders
 * `export-request` and `export-row` / `export-download` (docs/testing/e6-selectors.md).
 */
export function ExportPanel({
  kinds,
  exports,
  labels,
  onRequest,
  onError,
  locale,
  className,
  ...props
}: ExportPanelProps): React.JSX.Element {
  const ctx = useLocale();
  const resolvedLocale = locale ?? ctx.locale;
  const id = React.useId();
  const [pending, setPending] = React.useState<string | null>(null);
  const request = async (kind: string): Promise<void> => {
    setPending(kind);
    try {
      await onRequest(kind);
    } catch (caught) {
      onError?.(caught);
    } finally {
      setPending(null);
    }
  };
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        {labels.description ? <CardDescription>{labels.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ItemGroup className="gap-2">
          {kinds.map((option) => {
            const reasonId = `${id}-${option.kind}-cooldown`;
            return (
              <Item key={option.kind} variant="outline" size="sm" className="flex-wrap">
                <ItemContent className="min-w-0">
                  <ItemTitle>{option.label}</ItemTitle>
                  {option.description ? <ItemDescription>{option.description}</ItemDescription> : null}
                  {option.cooldownUntil ? (
                    <ItemDescription id={reasonId} data-cooldown-until={option.cooldownUntil}>
                      {labels.cooldown(<RelativeTime date={option.cooldownUntil} />)}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="export-request"
                    data-kind={option.kind}
                    disabled={option.cooldownUntil !== null || pending !== null}
                    aria-busy={pending === option.kind || undefined}
                    aria-describedby={option.cooldownUntil ? reasonId : undefined}
                    onClick={() => void request(option.kind)}
                  >
                    <HugeiconsIcon icon={FileExportIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                    {labels.request}
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        {exports === null ? (
          <SkeletonGroup>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : exports.length === 0 ? (
          <EmptyState
            data-testid="export-empty"
            icon={Download01Icon}
            title={labels.emptyTitle}
            description={labels.emptyDescription}
            headingLevel={3}
          />
        ) : (
          <ItemGroup aria-label={labels.listLabel} className="gap-2">
            {exports.map((job) => (
              <Item
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
                role="listitem"
                key={job.id}
                variant="muted"
                size="sm"
                data-testid="export-row"
                data-export-id={job.id}
                data-kind={job.kind}
                data-status={job.status}
                className="flex-wrap"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">
                    {job.kindLabel}
                    <StatusBadge tone={exportStatusTone(job.status)}>{job.statusLabel}</StatusBadge>
                  </ItemTitle>
                  <ItemDescription className="flex flex-wrap gap-x-2">
                    <span>{labels.requested(<RelativeTime date={job.createdAt} />)}</span>
                    {job.sizeBytes !== null ? (
                      <span className="tabular-nums" data-size-bytes={job.sizeBytes}>
                        {formatBytes(job.sizeBytes, resolvedLocale)}
                      </span>
                    ) : null}
                    {job.status === "ready" && job.expiresAt ? (
                      <span>{labels.expires(<RelativeTime date={job.expiresAt} />)}</span>
                    ) : null}
                  </ItemDescription>
                </ItemContent>
                {job.status === "ready" && job.downloadUrl ? (
                  <ItemActions>
                    <Button
                      size="sm"
                      nativeButton={false}
                      // A signed link: never leak it through Referer.
                      render={
                        <a href={job.downloadUrl} rel="noreferrer noopener" download aria-label={labels.download} />
                      }
                      data-testid="export-download"
                    >
                      <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                      {labels.download}
                    </Button>
                  </ItemActions>
                ) : null}
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}
