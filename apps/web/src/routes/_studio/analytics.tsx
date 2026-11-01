// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { AnalyticsView } from "../../components/analytics/analytics-page.tsx";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** `/analytics`: verified audience, exclusions, delivery and marginal cost per broadcast (ADR 0014, decision (k)). */
export const Route = createFileRoute("/_studio/analytics")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: AnalyticsPage,
});

function AnalyticsPage(): React.JSX.Element {
  const { me, now } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <AnalyticsView channel={me.channelSlug ?? me.username} now={now} />;
}
