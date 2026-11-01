// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/admin/federation`: the instance's ActivityPub domain blocks and key rotation (ADR 0030),
 * admins only (the `_admin` guard). Placeholder: N4-web fills it.
 */
export const Route = createFileRoute("/_admin/admin/federation")({
  component: () => <NotFoundState />,
});
