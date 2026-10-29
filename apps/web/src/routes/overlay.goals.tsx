// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlayGoalsPage } from "../components/overlay-goals-page.tsx";
import { t } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { overlayHead } from "../lib/overlay-page.ts";

/**
 * The OBS goals overlay (E8): goal bars from `interact.overlays.state` and the overlay stream's
 * `goal` events. No layout, no session guard, no chrome; the token is the query's `token`.
 */
export const Route = createFileRoute("/overlay/goals")({
  head: () => overlayHead(t("overlay.goalsTitle")),
  component: GoalsOverlay,
});

function GoalsOverlay(): React.JSX.Element {
  const { config } = useBootstrap();
  return <OverlayGoalsPage currency={config.currency} />;
}
