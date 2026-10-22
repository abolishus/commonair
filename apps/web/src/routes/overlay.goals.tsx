// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Target02Icon } from "@hugeicons/core-free-icons";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlayPlaceholder } from "../components/overlay-placeholder.tsx";
import { t } from "../i18n/index.ts";
import { overlayHead } from "../lib/overlay-page.ts";

/** Goals stay 501 in E6 (ADR 0021): the URL exists so OBS setups need not change later. */
export const Route = createFileRoute("/overlay/goals")({
  head: () => overlayHead(t("overlay.goalsTitle")),
  component: GoalsOverlay,
});

function GoalsOverlay(): React.JSX.Element {
  return (
    <OverlayPlaceholder
      kind="goals"
      icon={Target02Icon}
      title={t("overlay.goalsTitle")}
      description={t("overlay.goalsLater")}
    />
  );
}
