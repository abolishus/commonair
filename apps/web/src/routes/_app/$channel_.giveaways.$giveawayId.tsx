// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { GiveawayVerifyPage } from "../../components/giveaways/verify-page.tsx";
import { GiveawayChannelFrame } from "../../components/watch/giveaway-channel.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/$channel/giveaways/$giveawayId`: a giveaway's public verify page (ADR 0039): the commitment,
 * the revealed seed (never the salt), the entry pseudonyms and the winners, and the draw re-run in the
 * browser with `@commonair/draw`. Public. `$channel_` keeps it out of the channel page's route
 * (which renders no outlet) while the URL stays `/$channel/giveaways/$giveawayId`. D3.9: framed by
 * the channel card and a link back to the channel.
 */
export const Route = createFileRoute("/_app/$channel_/giveaways/$giveawayId")({
  head: ({ params }) => titleHead(t("pageTitle.giveawayVerify", { name: params.channel })),
  component: GiveawayRoute,
});

function GiveawayRoute(): React.JSX.Element {
  const { channel, giveawayId } = Route.useParams();
  const { me } = useBootstrap();
  return (
    <GiveawayChannelFrame key={channel} slug={channel} signedIn={me !== null}>
      <GiveawayVerifyPage key={giveawayId} channel={channel} giveawayId={giveawayId} signedIn={me !== null} />
    </GiveawayChannelFrame>
  );
}
