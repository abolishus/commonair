// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Signed in: notification preferences and browser push (ADR 0028). Placeholder until N1-inbox fills it. */
export const Route = createFileRoute("/_app/settings/notifications/")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
