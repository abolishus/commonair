// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/** Settings → Preferences: the language choice (batch 5 decision (e)). A stub until N2-switcher fills it. */
export function PreferencesPage(): React.JSX.Element {
  return (
    <PageContainer width="narrow" data-testid="preferences-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("preferences.pageTitle")} />
    </PageContainer>
  );
}
