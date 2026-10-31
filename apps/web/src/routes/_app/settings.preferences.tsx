// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { PreferencesPage } from "../../components/locale/preferences-page.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Settings: the member's language (ADR 0029 decision 3; batch 5 decision (e)). */
export const Route = createFileRoute("/_app/settings/preferences")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => ({ meta: [{ title: t("preferences.pageTitle") }] }),
  component: PreferencesRoute,
});

function PreferencesRoute(): React.JSX.Element {
  const { me, locale, localeFromUser } = useBootstrap();
  // Client fallback for a session that ended after the guard ran.
  if (!me) return <Navigate to="/signin" replace />;
  return <PreferencesPage initial={localeFromUser ? locale : null} />;
}
