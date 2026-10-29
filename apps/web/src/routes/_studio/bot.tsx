// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Studio: the channel bot (settings, filters, points, song requests, commands, timers and variables) (E8-studio). Placeholder from the E8 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_studio/bot")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
