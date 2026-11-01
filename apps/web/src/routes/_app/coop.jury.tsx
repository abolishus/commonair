// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/coop/jury`: the advisory jury (ADR 0038): opt in or out, and a seated juror's cases and votes.
 * Placeholder: W3-jury fills it.
 */
export const Route = createFileRoute("/_app/coop/jury")({
  component: () => <NotFoundState />,
});
