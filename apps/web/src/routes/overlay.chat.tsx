// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlayChatPage } from "../components/overlay-chat-page.tsx";
import { t } from "../i18n/index.ts";
import { overlayHead } from "../lib/overlay-page.ts";

/**
 * The OBS chat overlay (E8): the token's channel chat, read-only and transparent. No layout, no
 * session guard, no chrome; the token is the query's `token`.
 */
export const Route = createFileRoute("/overlay/chat")({
  head: () => overlayHead(t("overlay.chatTitle")),
  component: ChatOverlay,
});

function ChatOverlay(): React.JSX.Element {
  return <OverlayChatPage />;
}
