// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Settings: apps you authorized, their scopes, revoke (E9-consent). Placeholder from the E9 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_app/settings/connections")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
