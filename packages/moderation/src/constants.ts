// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Legal floors and matching rules (ADR 0006 decision 5). These are code constants on purpose:
 * no env var, governance setting or vote can change them. The NCII hours are also enforced by
 * the database (`ncii_requests.deadline_at`, migration 0016).
 */
import { MODERATION_FRAME_TTL_SECONDS } from "@commonair/contracts/internal";

export const MODERATION_CONSTANTS = {
  /** A T0 match: Hamming distance ≤ this of 256 bits (Meta's recommended PDQ threshold). */
  PDQ_MATCH_DISTANCE: 31,
  /** Frames below this PDQ quality are never matched (near-uniform frames collide); still classified. */
  PDQ_MIN_QUALITY: 50,
  /** Side of the raw 8-bit luma frame media hands to PDQ. */
  PDQ_LUMA_SIZE: 512,
  /** Side of the raw RGB frame the classifier reads (ViT-384). */
  CLASSIFIER_INPUT_SIZE: 384,
  /** First live sample within this many seconds of publish. */
  STREAM_START_SAMPLE_SECONDS: 3,
  /** Media drops classifier (never PDQ) jobs once the queue is this many intervals behind. */
  CLASSIFIER_BACKLOG_INTERVALS: 3,
  FRAME_TTL_SECONDS: MODERATION_FRAME_TTL_SECONDS,
  /** Largest plaintext stored inline in `evidence_objects` (the sealed row allows 1 MiB + 1 KiB). */
  EVIDENCE_INLINE_MAX_BYTES: 1_048_576,
  /** T1 response SLA and queue priority; `minor_safety`/`ncii` reports outrank everything. */
  T1_SLA_MINUTES: 15,
  T1_PRIORITY: 100,
  URGENT_REPORT_PRIORITY: 1000,
  /** T1/T2 review frames are deleted this long after their case closes. */
  REVIEW_FRAME_RETENTION_DAYS: 30,
  /** 18 U.S.C. 2258A(h) as amended by the REPORT Act: preserve one year after filing. */
  HOLD_PRESERVATION_DAYS: 365,
  NCMEC_UNFILED_ALERT_HOURS: 24,
  NCMEC_UNFILED_INCIDENT_HOURS: 72,
  /** TAKE IT DOWN Act clock: escalations, then automatic hiding at the deadline. */
  NCII_ESCALATE_FIRST_HOURS: 24,
  NCII_ESCALATE_SECOND_HOURS: 36,
  NCII_DEADLINE_HOURS: 48,
  /** An NCII clock run later than this after the previous one raises an alert. */
  NCII_CLOCK_LAPSE_ALERT_MINUTES: 5,
  /** Unflagged objects under the incoming upload prefix are deleted after this. */
  INCOMING_UPLOAD_TTL_HOURS: 24,
} as const;

/** Unpublished prefix presigned uploads land in; never served (ADR 0006 Q6). */
export const INCOMING_PREFIX = "incoming/";
/** Private prefix of T1/T2 review frames in the media bucket: `moderation/<caseId>/<flagId>.jpg`. */
export const reviewFrameKey = (caseId: string, flagId: string) => `moderation/${caseId}/${flagId}.jpg`;
