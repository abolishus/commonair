// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Message01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlayPlaceholder } from "../components/overlay-placeholder.tsx";
import { t } from "../i18n/index.ts";
import { overlayHead } from "../lib/overlay-page.ts";

/** The chat overlay is not built in E6 (ADR 0021): the URL exists so OBS setups need not change later. */
export const Route = createFileRoute("/overlay/chat")({
  head: () => overlayHead(t("overlay.chatTitle")),
  component: ChatOverlay,
});

function ChatOverlay(): React.JSX.Element {
  return (
    <OverlayPlaceholder
      kind="chat"
      icon={Message01Icon}
      title={t("overlay.chatTitle")}
      description={t("overlay.chatLater")}
    />
  );
}
