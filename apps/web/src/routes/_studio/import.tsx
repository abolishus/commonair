// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/**
 * `/import`: import a channel from Twitch (ADR 0031): connect, preview, choose, start, and the
 * panel paste-in helper; an unavailable state without the Twitch credentials or the flag.
 * Placeholder: N3-import fills it.
 */
export const Route = createFileRoute("/_studio/import")({
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
