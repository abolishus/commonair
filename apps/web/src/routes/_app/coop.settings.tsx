// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { SettingsPage } from "../../components/coop/council.tsx";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { coopLoads, useCoopLoad } from "../../components/coop/use-coop.ts";
import { api } from "../../lib/api.ts";

/** Public: the governance settings and the decision that last set each. */
export const Route = createFileRoute("/_app/coop/settings")({ component: SettingsRoute });

function SettingsRoute(): React.JSX.Element {
  const settings = useCoopLoad("settings", () => api().coop.settings());
  return (
    <CoopLoadGate status={coopLoads([settings])} tab="settings">
      <SettingsPage settings={settings.data} />
    </CoopLoadGate>
  );
}
