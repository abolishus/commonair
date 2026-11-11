// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { LanguageSection } from "../../components/locale/preferences-page.tsx";
import { PlaybackSection, ThemeSection } from "../../components/settings/preferences-sections.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Settings → Preferences (D7.1 P7, how the site behaves): the member's language (ADR 0029
 * decision 3), the theme, and playback on this device.
 */
export const Route = createFileRoute("/_app/settings/preferences")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => titleHead(t("d7Settings.nav.preferences")),
  component: PreferencesRoute,
});

function PreferencesRoute(): React.JSX.Element {
  const { me, locale, localeFromUser } = useBootstrap();
  // Client fallback for a session that ended after the guard ran.
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="preferences-page" className="flex flex-col gap-6">
      <PageHeader title={t("d7Settings.nav.preferences")} description={t("d7Settings.prefs.intro")} />
      <LanguageSection initial={localeFromUser ? locale : null} />
      <ThemeSection />
      <PlaybackSection />
    </div>
  );
}
