// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { SettingsPage } from "../../components/coop/council.tsx";
import { CoopSectionError } from "../../components/coop/load-error.tsx";
import { useCoopLoad } from "../../components/coop/use-coop.ts";
import { api } from "../../lib/api.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Public: the governance settings and the decision that last set each. */
export const Route = createFileRoute("/_app/coop/settings")({
  head: () => titleHead(t("pageTitle.coopSettings")),
  component: SettingsRoute,
});

function SettingsRoute(): React.JSX.Element {
  const settings = useCoopLoad("settings", () => api().coop.settings());
  return (
    // F3: the header and the protected-settings note stay; the list fails in place.
    <SettingsPage
      settings={settings.data}
      error={
        settings.state === "failed" ? (
          <CoopSectionError section={t("coop.settings.title")} load={settings} alone headingLevel={2} />
        ) : null
      }
    />
  );
}
