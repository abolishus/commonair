// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/**
 * `/move`: channel portability (ADR 0037): move links and their conversions, "moved to", and the
 * bundle export and import. Placeholder: W3-portability fills it.
 */
export const Route = createFileRoute("/_studio/move")({
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
