// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Display labels for DMCA enums (literal catalog keys, so the i18n usage check sees each one). */
import type { StatusTone } from "@commonair/ui";
import { t } from "../../i18n/index.ts";
import type { DmcaNoticeItemDto, DmcaStatus } from "./client.ts";

export const DMCA_STATUS_ORDER: readonly DmcaStatus[] = ["received", "actioned", "rejected", "countered", "restored"];

export function dmcaStatusLabel(s: DmcaStatus): string {
  switch (s) {
    case "received":
      return t("dmcaq.status.received");
    case "actioned":
      return t("dmcaq.status.actioned");
    case "rejected":
      return t("dmcaq.status.rejected");
    case "countered":
      return t("dmcaq.status.countered");
    case "restored":
      return t("dmcaq.status.restored");
  }
}

export function dmcaStatusTone(s: DmcaStatus): StatusTone {
  switch (s) {
    case "received":
      return "warning";
    case "actioned":
      return "danger";
    case "rejected":
      return "neutral";
    case "countered":
      return "info";
    case "restored":
      return "success";
  }
}

export function subjectLabel(s: DmcaNoticeItemDto["subjectType"]): string {
  switch (s) {
    case "vod":
      return t("copyright.subject.vod");
    case "clip":
      return t("copyright.subject.clip");
    case "broadcast":
      return t("copyright.subject.broadcast");
    case null:
      return t("copyright.subject.unresolved");
  }
}

/** Where one item stands, for its owner and for staff. */
export function itemStateLabel(i: Pick<DmcaNoticeItemDto, "removedAt" | "restoredAt" | "subjectType">): string {
  if (i.restoredAt) return t("copyright.item.restored");
  if (i.removedAt) return t("copyright.item.removed");
  if (i.subjectType === null) return t("copyright.item.unresolved");
  return t("copyright.item.notRemoved");
}
