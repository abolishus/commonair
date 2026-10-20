// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Presentation helpers for the chat panel: name colors and the connection status chip. */
import type { StatusTone } from "@commonair/ui";
import { t } from "../i18n/index.ts";
import type { ChatBadgeKind } from "@commonair/ui/blocks/media";
import type { ChatMessageFrame, ChatStatus } from "./connection.ts";

/** `ChatMessage` color index (1–12, the AA-checked `--chat-N` tokens), stable per username. */
export function nameColorIndex(username: string): number {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 12) + 1;
}

type WireBadge = ChatMessageFrame["user"]["badges"][number]["type"];

/** `data-badges` on `chat-message`: the sender's badge types, space-separated, "" when none. */
export function badgeAttr(badges: readonly { type: WireBadge }[]): string {
  return [...new Set(badges.map((b) => b.type))].join(" ");
}

function badgeLabel(type: ChatBadgeKind): string {
  switch (type) {
    case "broadcaster":
      return t("chat.badge.broadcaster");
    case "moderator":
      return t("chat.badge.moderator");
    case "vip":
      return t("chat.badge.vip");
    case "subscriber":
      return t("chat.badge.subscriber");
    case "member":
      return t("chat.badge.member");
  }
}

const SHOWN: readonly ChatBadgeKind[] = ["broadcaster", "moderator", "vip", "subscriber", "member"];

/** The visible `ChatMessage` badges (kinds the composition draws; bot/staff stay attribute-only). */
export function visibleBadges(badges: readonly { type: WireBadge }[]): { kind: ChatBadgeKind; label: string }[] {
  const kinds = new Set(badges.map((b) => b.type));
  return SHOWN.filter((kind) => kinds.has(kind)).map((kind) => ({ kind, label: badgeLabel(kind) }));
}

export function chatStatusView(status: ChatStatus): { label: string; tone: StatusTone } {
  if (status === "open") return { label: t("chat.status.open"), tone: "success" };
  if (status === "connecting") return { label: t("chat.status.connecting"), tone: "info" };
  return { label: t("chat.status.closed"), tone: "warning" };
}
