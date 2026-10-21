// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { TakedownForm } from "../../components/safety/takedown-form.tsx";
import { t } from "../../i18n/index.ts";

/** Public: the NCII takedown request (TAKE IT DOWN Act). No account needed. */
export const Route = createFileRoute("/_app/takedown")({ component: TakedownPage });

function TakedownPage(): React.JSX.Element {
  return (
    <PageContainer width="narrow" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("safety.takedown.title")} description={t("safety.takedown.intro")} />
      <AlertCallout
        tone="info"
        title={t("safety.takedown.howTitle")}
        description={
          <div className="flex flex-col gap-2">
            <p>{t("safety.takedown.how1")}</p>
            <p>{t("safety.takedown.how2")}</p>
            <p>{t("safety.takedown.how3")}</p>
          </div>
        }
      />
      <TakedownForm />
    </PageContainer>
  );
}
