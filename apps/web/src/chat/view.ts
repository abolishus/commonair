// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Presentation helpers for the chat panel: name colors and the connection status chip. */
import type { StatusTone } from "@commonair/ui";
import { t } from "../i18n/index.ts";
import type { ChatStatus } from "./connection.ts";

/** `ChatMessage` color index (1–12, the AA-checked `--chat-N` tokens), stable per username. */
export function nameColorIndex(username: string): number {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 12) + 1;
}

export function chatStatusView(status: ChatStatus): { label: string; tone: StatusTone } {
  if (status === "open") return { label: t("chat.status.open"), tone: "success" };
  if (status === "connecting") return { label: t("chat.status.connecting"), tone: "info" };
  return { label: t("chat.status.closed"), tone: "warning" };
}
