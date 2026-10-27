// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Admins (the `_admin` guard): status-page incidents (E7-admin). Placeholder from the E7 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_admin/admin/incidents")({
  component: () => <NotFoundState />,
});
