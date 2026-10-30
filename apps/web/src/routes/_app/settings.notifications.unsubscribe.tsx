// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * Anyone: confirms an email unsubscribe link (`GET /api/email/unsubscribe` redirects here with the
 * same query; ADR 0028 Amendment 1). No session guard: the token is the authority. The page
 * validates the strings. Placeholder until N1-email fills it.
 */
export const Route = createFileRoute("/_app/settings/notifications/unsubscribe")({
  validateSearch: (search: Record<string, unknown>): { list?: string; token?: string } => ({
    ...(typeof search.list === "string" ? { list: search.list } : {}),
    ...(typeof search.token === "string" ? { token: search.token } : {}),
  }),
  component: () => <NotFoundState />,
});
