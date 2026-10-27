// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/** Platform moderators (the `_admin` guard): the DMCA queue (E7-dmca). Placeholder from the E7 contract step; its unit fills it (never renames or removes it). */
export const Route = createFileRoute("/_admin/admin/dmca")({
  component: () => <NotFoundState />,
});
