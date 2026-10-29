// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Studio: bot accounts you own and their tokens; tokens authorized on your account (E9-console). Placeholder from the E9 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_studio/developer/bots")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
