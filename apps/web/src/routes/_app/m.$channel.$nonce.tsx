// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { MoveLanding } from "../../components/portability/landing.tsx";
import { useBootstrap } from "../../lib/bootstrap.ts";

/**
 * `/m/$channel/$nonce`: a move link's landing page (ADR 0037): the channel card and a follow button
 * that passes `moveLink` to `channels.follow`; a revoked or expired link shows an empty state.
 * Public. Caddy keeps `/m/*` on web.
 */
export const Route = createFileRoute("/_app/m/$channel/$nonce")({
  component: MoveLandingRoute,
});

function MoveLandingRoute(): React.JSX.Element {
  const { channel, nonce } = Route.useParams();
  const { me } = useBootstrap();
  return (
    <PageContainer width="narrow" className="flex flex-col gap-6 py-8">
      <MoveLanding key={`${channel}/${nonce}`} channel={channel} nonce={nonce} signedIn={me !== null} />
    </PageContainer>
  );
}
