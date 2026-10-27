// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Signed in: notices about your content and the counter-notice form (E7-dmca). Placeholder from the E7 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_app/settings/copyright")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: () => <NotFoundState />,
});
