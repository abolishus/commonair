// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { InboxPage } from "../../components/notifications/inbox-page.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Signed in: every notification, grouped and filterable (overhaul wave 4, D7.3). */
export const Route = createFileRoute("/_app/inbox")({
  head: () => titleHead(t("d7Notify.inbox.title")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: Inbox,
});

function Inbox(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <InboxPage />;
}
