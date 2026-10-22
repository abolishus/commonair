// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { SettingsPage } from "../../components/coop/council.tsx";
import { FormError } from "../../components/form-error.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";

/** Public: the governance settings and the decision that last set each. */
export const Route = createFileRoute("/_app/coop/settings")({ component: SettingsRoute });

function SettingsRoute(): React.JSX.Element {
  const settings = useLoad("settings", () => api().coop.settings());
  return (
    <>
      {settings.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <SettingsPage settings={settings.data ?? (settings.failed ? [] : null)} />
    </>
  );
}
