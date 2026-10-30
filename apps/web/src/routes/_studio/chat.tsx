// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** `/chat`: the verified-watch gate and surge-guard settings (ADR 0015). Placeholder: W1-watch-gate fills it. */
export const Route = createFileRoute("/_studio/chat")({
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
