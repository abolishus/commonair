// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The trust & safety calls the pages make, as small interfaces: the routes pass the real API,
 * tests pass stubs. Evidence and frame bytes returned here live only in component state (never
 * a cache, storage or URL) and are dropped on unmount.
 */
import type * as D from "@commonair/contracts/dto";
import type {
  MODERATION_REVIEW_DECISIONS,
  NCII_DECISIONS,
  NCII_RELATIONSHIPS,
  REPORT_REASONS,
  REPORT_SUBJECTS,
} from "@commonair/contracts/enums";
import type { z } from "zod";
import { api, errorCode } from "../../lib/api.ts";

export type AppealDto = z.infer<typeof D.Appeal>;
export type ReportDto = z.infer<typeof D.Report>;
export type ContentLabelDto = D.ContentLabel;
export type AccountActionDto = D.AccountAction;
export type ModerationCaseDto = D.ModerationCase;
export type ModerationCaseDetailDto = D.ModerationCaseDetail;
export type LegalCaseDto = D.LegalCase;
export type EvidenceObjectDto = D.EvidenceObject;
export type LegalHoldDto = D.LegalHold;
export type NcmecReportDto = D.NcmecReport;
export type NcmecReportDetailDto = z.infer<typeof D.NcmecReportDetail>;
export type NciiRequestDto = D.NciiRequest;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportSubject = (typeof REPORT_SUBJECTS)[number];
export type ReviewDecision = (typeof MODERATION_REVIEW_DECISIONS)[number];
export type NciiDecision = (typeof NCII_DECISIONS)[number];
export type NciiRelationship = (typeof NCII_RELATIONSHIPS)[number];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ImageData {
  contentType: string;
  dataBase64: string;
}

/** `data:` URL for an image returned by the API (only image types are rendered). */
export function imageDataUrl(image: ImageData): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(image.contentType)) return null;
  return `data:${image.contentType};base64,${image.dataBase64}`;
}

/** `playback.start` refused because the viewer has not confirmed 18+ (`MATURE_GATE`). */
export function isMatureGate(err: unknown): boolean {
  if (errorCode(err) !== "FORBIDDEN" || typeof err !== "object" || err === null || !("data" in err)) return false;
  const data = err.data;
  return typeof data === "object" && data !== null && "reason" in data && data.reason === "mature_gate";
}

// ── Viewer side ──────────────────────────────────────────────────────────────────────────────

export interface ReportClient {
  report(input: {
    subjectType: ReportSubject;
    subjectId: string;
    reason: ReportReason;
    details: string;
    /** `message_set` only: the wave's messages (W1, Calm Chat). */
    messageIds?: string[];
  }): Promise<{ id: string }>;
}
export const reportClient = (): ReportClient => ({ report: (input) => api().safety.report(input) });

export interface MaturityClient {
  me(): Promise<{ isAdult: boolean; matureConfirmed: boolean }>;
  confirmMature(): Promise<unknown>;
}
export const maturityClient = (): MaturityClient => ({
  me: () => api().me.get(),
  confirmMature: () => api().me.confirmMature(),
});

export interface NciiSubmitInput {
  requesterName: string;
  requesterEmail: string;
  relationship: NciiRelationship;
  contentUrls: string[];
  description: string;
  goodFaith: true;
  signature: string;
  altcha: string;
}
export interface TakedownClient {
  submit(input: NciiSubmitInput): Promise<{ id: string; deadlineAt: string }>;
}
export const takedownClient = (): TakedownClient => ({ submit: (input) => api().ncii.submit(input) });

export interface AppealsClient {
  labels(): Promise<ContentLabelDto[]>;
  mine(): Promise<AppealDto[]>;
  appealLabel(labelId: string, body: string): Promise<AppealDto>;
}
export const appealsClient = (): AppealsClient => ({
  labels: () => api().me.labels(),
  mine: () => api().appeals.mine(),
  appealLabel: (labelId, body) =>
    api().appeals.create({ kind: "moderation", subjectType: "content_label", subjectId: labelId, body }),
});

/** DMCA strikes and the repeat-infringer termination about the viewer, appealable as `account`. */
export interface AccountActionsClient {
  list(): Promise<AccountActionDto[]>;
  appeal(actionId: string, body: string): Promise<AppealDto>;
}
export const accountActionsClient = (): AccountActionsClient => ({
  list: () => api().appeals.accountActions(),
  appeal: (actionId, body) =>
    api().appeals.create({ kind: "account", subjectType: "account_action", subjectId: actionId, body }),
});

// ── Staff ────────────────────────────────────────────────────────────────────────────────────

export interface ModerationClient {
  cases(input: { tier: "t1" | "t2"; status: "open" | "labelled"; cursor?: string }): Promise<Page<ModerationCaseDto>>;
  case(id: string): Promise<ModerationCaseDetailDto>;
  frame(flagId: string): Promise<ImageData>;
  review(input: {
    id: string;
    decision: ReviewDecision;
    note: string;
    suspendTarget: "channel" | "user" | "both";
    durationSeconds?: number;
  }): Promise<ModerationCaseDto>;
  reports(cursor?: string): Promise<Page<ReportDto>>;
  resolveReport(input: { id: string; status: "actioned" | "dismissed"; resolution: string }): Promise<ReportDto>;
  ncii(cursor?: string): Promise<Page<NciiRequestDto>>;
  decideNcii(input: { id: string; decision: NciiDecision; note: string }): Promise<NciiRequestDto>;
}
const PAGE = 50;
export const moderationClient = (): ModerationClient => ({
  cases: (input) => api().moderation.queue({ ...input, limit: PAGE }),
  case: (id) => api().moderation.case({ id }),
  frame: (id) => api().moderation.frame({ id }),
  review: (input) => api().moderation.review(input),
  reports: (cursor) => api().safety.queue({ status: "open", limit: PAGE, cursor }),
  resolveReport: (input) => api().safety.resolve({ ...input, action: "none" }),
  ncii: (cursor) => api().ncii.queue({ limit: PAGE, cursor }),
  decideNcii: (input) => api().ncii.decide(input),
});

export interface AppealQueueClient {
  queue(cursor?: string): Promise<Page<AppealDto>>;
  resolve(input: { id: string; status: "upheld" | "overturned"; resolution: string }): Promise<AppealDto>;
}
export const appealQueueClient = (): AppealQueueClient => ({
  queue: (cursor) => api().appeals.queue({ status: "open", limit: PAGE, cursor }),
  resolve: (input) => api().appeals.resolve(input),
});

export interface LegalClient {
  cases(cursor?: string): Promise<Page<LegalCaseDto>>;
  confirmCase(id: string, note: string): Promise<LegalCaseDto>;
  dismiss(id: string, note: string): Promise<{ case: LegalCaseDto; mediaRestored: false }>;
  evidence(id: string): Promise<ImageData>;
  reports(cursor?: string): Promise<Page<NcmecReportDto>>;
  report(id: string): Promise<NcmecReportDetailDto>;
  file(input: { id: string; externalReportId: string; filedAt: string }): Promise<NcmecReportDto>;
  holds(cursor?: string): Promise<Page<LegalHoldDto>>;
}
export const legalClient = (): LegalClient => ({
  cases: (cursor) => api().moderation.t0Queue({ limit: PAGE, cursor }),
  confirmCase: (id, note) => api().moderation.t0Confirm({ id, note }),
  dismiss: (id, note) => api().moderation.t0Dismiss({ id, note }),
  evidence: (id) => api().moderation.evidence({ id }),
  reports: (cursor) => api().moderation.ncmecReports({ limit: PAGE, cursor }),
  report: (id) => api().moderation.ncmecReport({ id }),
  file: (input) => api().moderation.ncmecFile(input),
  holds: (cursor) => api().moderation.holds({ active: true, limit: PAGE, cursor }),
});
