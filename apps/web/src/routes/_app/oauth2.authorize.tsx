// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** OAuth consent for an app's authorization request (E9-consent; ADR 0027 §1). Signed out: sign-in returns here. Placeholder from the E9 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_app/oauth2/authorize")({
  beforeLoad: ({ location }) => requireSession(() => getSessionUser(), { returnTo: location.href }),
  component: () => <NotFoundState />,
});
