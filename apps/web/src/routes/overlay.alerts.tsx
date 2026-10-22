// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlayAlertsPage } from "../components/overlay-alerts-page.tsx";
import { t } from "../i18n/index.ts";
import { overlayHead } from "../lib/overlay-page.ts";

/**
 * The OBS alert overlay: no layout, no session guard, no chrome, a transparent page (the root
 * drops its background on `/overlay/*`). The token is the query's `token`.
 */
export const Route = createFileRoute("/overlay/alerts")({
  head: () => overlayHead(t("overlay.alertsTitle")),
  component: AlertsOverlay,
});

function AlertsOverlay(): React.JSX.Element {
  return <OverlayAlertsPage />;
}
