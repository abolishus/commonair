// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import { NotFoundState } from "../../components/money/not-found.tsx";

/**
 * `/$channel/giveaways/$giveawayId`: a giveaway's public verify page (ADR 0039): the commitment,
 * the revealed seed (never the salt), the entry pseudonyms and the winners, and the draw re-run in the
 * browser with `@commonair/draw`. Public. `$channel_` keeps it out of the channel page's route
 * (which renders no outlet) while the URL stays `/$channel/giveaways/$giveawayId`.
 * Placeholder: W3-giveaways fills it.
 */
export const Route = createFileRoute("/_app/$channel_/giveaways/$giveawayId")({
  component: () => <NotFoundState />,
});
