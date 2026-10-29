// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Device activation: enter a device's user code, then consent (E9-consent; RFC 8628). Signed out: sign-in returns here. Placeholder from the E9 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_app/activate")({
  beforeLoad: ({ location }) => requireSession(() => getSessionUser(), { returnTo: location.href }),
  component: () => <NotFoundState />,
});
