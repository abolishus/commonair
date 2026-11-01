// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** `/rehearse`: arm a private rehearsal, invite up to five, read the report (decisions (f), (g)). Placeholder: W2-rehearsal fills it. */
export const Route = createFileRoute("/_studio/rehearse")({
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
