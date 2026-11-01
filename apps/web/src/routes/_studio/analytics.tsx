// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** `/analytics`: verified audience, exclusions and marginal cost per broadcast (ADR 0014). Placeholder: W2-rollup-analytics fills it. */
export const Route = createFileRoute("/_studio/analytics")({
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
