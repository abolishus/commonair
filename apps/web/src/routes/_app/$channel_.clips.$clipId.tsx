// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/$channel/clips/$clipId`: the public clip watch page with the clip window's chat (decision
 * (e)). Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/clips/$clipId`.
 * Placeholder: W2-vod-watch fills it.
 */
export const Route = createFileRoute("/_app/$channel_/clips/$clipId")({
  component: () => <NotFoundState />,
});
