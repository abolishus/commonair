// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/$channel/vods/$vodId`: the public VOD watch page with the chat replay panel (decision (e)).
 * Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/vods/$vodId`.
 * Placeholder: W2-vod-watch fills it.
 */
export const Route = createFileRoute("/_app/$channel_/vods/$vodId")({
  component: () => <NotFoundState />,
});
