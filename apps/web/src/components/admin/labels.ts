// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Labels and badge tones for the E7 admin pages (every key spelled out, so the catalog check sees it). */
import type { StatusTone } from "@commonair/ui";
import { t } from "../../i18n/index.ts";
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
