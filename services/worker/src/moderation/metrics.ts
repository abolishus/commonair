// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Trust & safety instruments. Attributes are tiers, categories, job names and outcomes only. */
import { meter } from "@commonair/observability";

const m = meter("commonair.worker.moderation");

export const moderationMetrics = {
  /** `moderation_frames_total{tier}`: t1, t2, t3 (nothing stored), plus `invalid` frames. */
  frames: m.createCounter("moderation_frames_total", { description: "Classified live frames by resulting tier" }),
  /** Frames whose RGB bytes had already expired from Valkey when the scan ran. */
  framesExpired: m.createCounter("moderation_frames_expired_total", {
    description: "Scan jobs whose frame had expired from Valkey (no action taken)",
  }),
  scores: m.createHistogram("moderation_classifier_score", {
    description: "Classifier scores per category (scored categories only)",
  }),
  classifyDuration: m.createHistogram("moderation_classify_duration", {
    unit: "ms",
    description: "Classifier inference time per frame",
  }),
  actions: m.createCounter("moderation_actions_total", {
    description: "Automated moderation actions by kind (t0, t0_escalated, t1_restrict, t1_flag, t2_label, ncii_*)",
  }),
  evidenceObjects: m.createCounter("moderation_evidence_objects_total", {
    description: "Evidence objects written, by kind and storage",
  }),
  alerts: m.createCounter("moderation_alerts_total", {
    description: "Trust & safety alerts by name; every alert also writes an error or fatal log line",
  }),
  runs: m.createCounter("moderation_job_runs_total", {
    description: "Scheduled moderation job runs by job and outcome (ran, skipped)",
  }),
  audit: m.createCounter("moderation_evidence_audit_objects_total", {
    description: "Evidence objects checked by the daily audit, by result (ok, missing, mismatched)",
  }),
  outboxInternal: m.createCounter("worker.outbox.internal", {
    description: "Internal (trust & safety) outbox events marked handled without publishing",
  }),
  deletions: m.createCounter("account_deletions_total", { description: "Account deletions completed, by outcome" }),
  /** Statements of reasons (ADR 0019): attributes are audit action names, channels and outcomes only. */
  sorStatements: m.createCounter("sor_statements_total", {
    description: "Statements of reasons inserted by the builder",
  }),
  sorBuildFailures: m.createCounter("sor_build_failures_total", {
    description: "Allowlisted audit rows the builder could not turn into a statement, by action (once per process)",
  }),
  sorDeliveries: m.createCounter("sor_deliveries_total", {
    description: "Statement deliveries by channel (email, in_app) and outcome (sent, failed, skipped)",
  }),
  sorMissing: m.createGauge("sor_missing_statements", {
    description: "Allowlisted audit rows older than 5 minutes with no statement (the coverage target is 0)",
  }),
};
