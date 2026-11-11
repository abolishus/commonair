// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { FollowingPage } from "../../components/following/following-page.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `/following` (D3.5): followed channels, live first, with go-live alerts. Loads in the browser. */
export const Route = createFileRoute("/_app/following")({
  head: () => titleHead(t("d3Home.followingPage.title")),
  component: Following,
});

function Following(): React.JSX.Element {
  const { me } = useBootstrap();
  return <FollowingPage me={me} />;
}
