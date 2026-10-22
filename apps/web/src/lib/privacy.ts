// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/settings/privacy` logic, pure for unit tests: export rows and kinds for `ExportPanel`, when
 * to poll, and the deletion request for `DeletionPanel`.
 */
import { DELETION_STATUSES, EXPORT_KINDS, JOB_STATUSES } from "@commonair/contracts/enums";
import { exportCooldownUntil, type ExportKindOption, type ExportRowData } from "@commonair/ui/blocks/privacy";
import type { DeletionRequestView } from "@commonair/ui/blocks/privacy";
import { t, type MessageKey } from "../i18n/index.ts";
import type { Api } from "./api.ts";

export type ExportJobDto = Awaited<ReturnType<Api["me"]["exports"]["list"]>>[number];
export type ExportKind = (typeof EXPORT_KINDS)[number];
export type DeletionRequestDto = NonNullable<Awaited<ReturnType<Api["me"]["deletion"]["get"]>>>;

/** While an export is queued or running the list is polled this often. */
export const EXPORTS_POLL_MS = 5_000;

const KIND_KEYS: Record<ExportKind, MessageKey> = {
  account: "privacy.export.kind.account",
  channel: "privacy.export.kind.channel",
};
const KIND_HINT_KEYS: Record<ExportKind, MessageKey> = {
  account: "privacy.export.kind.accountHint",
  channel: "privacy.export.kind.channelHint",
};
const JOB_STATUS_KEYS: Record<(typeof JOB_STATUSES)[number], MessageKey> = {
  queued: "privacy.export.status.queued",
  running: "privacy.export.status.running",
  ready: "privacy.export.status.ready",
  failed: "privacy.export.status.failed",
  expired: "privacy.export.status.expired",
};
const DELETION_STATUS_KEYS: Record<(typeof DELETION_STATUSES)[number], MessageKey> = {
  scheduled: "privacy.deletion.status.scheduled",
  canceled: "privacy.deletion.status.canceled",
  completed: "privacy.deletion.status.completed",
};

/** `channel` only for someone who owns a channel (the API answers PRECONDITION_FAILED otherwise). */
export function exportKinds(hasChannel: boolean): ExportKind[] {
  return EXPORT_KINDS.filter((kind) => kind === "account" || hasChannel);
}

export function exportKindOptions(
  kinds: readonly ExportKind[],
  exports: readonly ExportJobDto[] | null,
  now: number,
): ExportKindOption[] {
  return kinds.map((kind) => ({
    kind,
    label: t(KIND_KEYS[kind]),
    description: t(KIND_HINT_KEYS[kind]),
    // Until the list arrives the API's own cooldown answers; the button is not held disabled.
    cooldownUntil: exports ? exportCooldownUntil(exports, kind, now) : null,
  }));
}

/**
 * Rows newest first. A link is offered only while the export is ready and its `expiresAt` is
 * still ahead (the API stops listing it then too; a page left open must not offer a dead link).
 */
export function exportRows(exports: readonly ExportJobDto[], now: number): ExportRowData[] {
  return [...exports]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((job) => {
      const live = job.status === "ready" && job.expiresAt !== null && Date.parse(job.expiresAt) > now;
      return {
        id: job.id,
        kind: job.kind,
        kindLabel: t(KIND_KEYS[job.kind]),
        status: job.status,
        statusLabel: t(JOB_STATUS_KEYS[job.status]),
        sizeBytes: job.sizeBytes,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        downloadUrl: live ? job.downloadUrl : null,
      };
    });
}

export function shouldPollExports(exports: readonly Pick<ExportJobDto, "status">[]): boolean {
  return exports.some((job) => job.status === "queued" || job.status === "running");
}

/** A new export first in the list, replacing a stale copy of the same id. */
export function withExport(exports: readonly ExportJobDto[] | null, job: ExportJobDto): ExportJobDto[] {
  return [job, ...(exports ?? []).filter((existing) => existing.id !== job.id)];
}

export function deletionView(request: DeletionRequestDto | null): DeletionRequestView | null {
  if (!request) return null;
  return {
    status: request.status,
    statusLabel: t(DELETION_STATUS_KEYS[request.status]),
    scheduledFor: request.scheduledFor,
  };
}
