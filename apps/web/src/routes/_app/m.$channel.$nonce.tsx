// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/m/$channel/$nonce`: a move link's landing page (ADR 0037): the channel card and a follow button
 * that passes `moveLink` to `channels.follow`; a revoked or expired link shows an empty state.
 * Public. Caddy keeps `/m/*` on web. Placeholder: W3-portability fills it.
 */
export const Route = createFileRoute("/_app/m/$channel/$nonce")({
  component: () => <NotFoundState />,
});
