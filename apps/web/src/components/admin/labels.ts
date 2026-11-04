// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Labels and badge tones for the E7 admin pages (every key spelled out, so the catalog check sees it). */
import { formatBytes, formatNumber, type StatusTone } from "@commonair/ui";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { DeliverySource, IncidentStatus, IntegrityDecision, IntegritySubject } from "./client.ts";

export function sourceLabel(s: DeliverySource): string {
  switch (s) {
    case "origin":
      return t("admin.egress.source.origin");
    case "relay":
      return t("admin.egress.source.relay");
    case "p2p":
      return t("admin.egress.source.p2p");
    case "cdn":
      return t("admin.egress.source.cdn");
  }
}

export function incidentStatusLabel(s: IncidentStatus): string {
  switch (s) {
    case "investigating":
      return t("admin.incidents.status.investigating");
    case "identified":
      return t("admin.incidents.status.identified");
    case "monitoring":
      return t("admin.incidents.status.monitoring");
    case "resolved":
      return t("admin.incidents.status.resolved");
  }
}

export function incidentTone(s: IncidentStatus): StatusTone {
  switch (s) {
    case "investigating":
      return "danger";
    case "identified":
    case "monitoring":
      return "warning";
    case "resolved":
      return "success";
  }
}

export function subjectLabel(s: IntegritySubject): string {
  switch (s) {
    case "session":
      return t("admin.integrity.subject.session");
    case "user":
      return t("admin.integrity.subject.user");
    case "channel":
      return t("admin.integrity.subject.channel");
    case "relay":
      return t("admin.integrity.subject.relay");
    case "follow":
      return t("admin.integrity.subject.follow");
    case "chat_message":
      return t("admin.integrity.subject.chatMessage");
    case "raid":
      return t("admin.integrity.subject.raid");
  }
}

export function decisionLabel(d: IntegrityDecision): string {
  switch (d) {
    case "pending_review":
      return t("admin.integrity.decision.pendingReview");
    case "excluded":
      return t("admin.integrity.decision.excluded");
    case "allowed":
      return t("admin.integrity.decision.allowed");
  }
}

export function decisionTone(d: IntegrityDecision): StatusTone {
  switch (d) {
    case "pending_review":
      return "warning";
    case "excluded":
      return "danger";
    case "allowed":
      return "success";
  }
}

// ── Integrity flag codes and detail keys (F34) ───────────────────────────────────────────────
// Every code `@commonair/integrity` writes to `integrity_flags.signal` (session, channel and relay
// signals), and the detail keys those flags carry. An unknown code or key (one added later)
// falls back to its raw text, which the page always shows small for search.

const SIGNAL_LABELS: Readonly<Record<string, { label: MessageKey; description: MessageKey }>> = {
  datacenter_ip: {
    label: "settings.integrity.signal.datacenterIp",
    description: "settings.integrity.signal.datacenterIp.hint",
  },
  privacy_relay: {
    label: "settings.integrity.signal.privacyRelay",
    description: "settings.integrity.signal.privacyRelay.hint",
  },
  device_concurrency: {
    label: "settings.integrity.signal.deviceConcurrency",
    description: "settings.integrity.signal.deviceConcurrency.hint",
  },
  account_concurrency: {
    label: "settings.integrity.signal.accountConcurrency",
    description: "settings.integrity.signal.accountConcurrency.hint",
  },
  headless: { label: "settings.integrity.signal.headless", description: "settings.integrity.signal.headless.hint" },
  heartbeat_inconsistent: {
    label: "settings.integrity.signal.heartbeatInconsistent",
    description: "settings.integrity.signal.heartbeatInconsistent.hint",
  },
  fetch_pattern: {
    label: "settings.integrity.signal.fetchPattern",
    description: "settings.integrity.signal.fetchPattern.hint",
  },
  chat_viewer_anomaly: {
    label: "settings.integrity.signal.chatViewerAnomaly",
    description: "settings.integrity.signal.chatViewerAnomaly.hint",
  },
  follow_burst: {
    label: "settings.integrity.signal.followBurst",
    description: "settings.integrity.signal.followBurst.hint",
  },
  raid_overstated: {
    label: "settings.integrity.signal.raidOverstated",
    description: "settings.integrity.signal.raidOverstated.hint",
  },
  relay_over_report: {
    label: "settings.integrity.signal.relayOverReport",
    description: "settings.integrity.signal.relayOverReport.hint",
  },
  relay_suspended: {
    label: "settings.integrity.signal.relaySuspended",
    description: "settings.integrity.signal.relaySuspended.hint",
  },
  relay_issuance_unknown: {
    label: "settings.integrity.signal.relayIssuanceUnknown",
    description: "settings.integrity.signal.relayIssuanceUnknown.hint",
  },
};

const DETAIL_LABELS: Readonly<Record<string, MessageKey>> = {
  receiptId: "settings.integrity.detail.receiptId",
  relayId: "settings.integrity.detail.relayId",
  tolerance: "settings.integrity.detail.tolerance",
  gapMinutes: "settings.integrity.detail.gapMinutes",
  bytesIssued: "settings.integrity.detail.bytesIssued",
  bytesReported: "settings.integrity.detail.bytesReported",
  bytesVerified: "settings.integrity.detail.bytesVerified",
  overReportRatio: "settings.integrity.detail.overReportRatio",
  worstRatio: "settings.integrity.detail.worstRatio",
  overReportingPeriods: "settings.integrity.detail.overReportingPeriods",
  periodsConsidered: "settings.integrity.detail.periodsConsidered",
  suspend: "settings.integrity.detail.suspend",
  since: "settings.integrity.detail.since",
  reason: "settings.integrity.detail.reason",
  sessionScore: "settings.integrity.detail.sessionScore",
  threshold: "settings.integrity.detail.threshold",
  checks: "settings.integrity.detail.checks",
  flags: "settings.integrity.detail.flags",
  network: "settings.integrity.detail.network",
  asn: "settings.integrity.detail.asn",
  rank: "settings.integrity.detail.rank",
  concurrent: "settings.integrity.detail.concurrent",
  max: "settings.integrity.detail.max",
  bursts: "settings.integrity.detail.bursts",
  excluded: "settings.integrity.detail.excluded",
  followedAt: "settings.integrity.detail.followedAt",
  accountAgeDays: "settings.integrity.detail.accountAgeDays",
  priorViewingSeconds: "settings.integrity.detail.priorViewingSeconds",
};

/** A flag code's catalogued title and what it means, or null for a code this page does not know. */
export function signalLabel(code: string): { label: string; description: string } | null {
  const keys = Object.hasOwn(SIGNAL_LABELS, code) ? SIGNAL_LABELS[code] : undefined;
  return keys ? { label: t(keys.label), description: t(keys.description) } : null;
}

/** A detail key's catalogued label, or null (the raw key is shown instead). */
export function detailLabel(key: string): string | null {
  const k = Object.hasOwn(DETAIL_LABELS, key) ? DETAIL_LABELS[key] : undefined;
  return k ? t(k) : null;
}

/** The detail keys counted in bytes, shown with the byte formatter. */
export const BYTE_DETAILS: ReadonlySet<string> = new Set(["bytesIssued", "bytesReported", "bytesVerified"]);

/**
 * Sizes for the admin pages (F34): the shared `formatBytes`, except under 1 kB, where `Intl`'s
 * short unit reads "0 byte"; there it is "0 B". (A contract request moves this into
 * `formatBytes` itself; then this becomes that call.)
 */
export function formatSize(bytes: number, locale: string): string {
  const n = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
  return n < 1000 ? t("settings.bytes", { value: formatNumber(n, locale) }) : formatBytes(n, locale);
}
