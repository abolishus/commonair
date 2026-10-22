// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppointWorkerForm, type AppointWorkerFormValues } from "@commonair/ui/blocks/coop";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

export interface AdminCoopPageProps {
  values: AppointWorkerFormValues;
  onValuesChange: (values: AppointWorkerFormValues) => void;
  /** Receives the trimmed username and board minute reference. */
  onAppoint: (values: AppointWorkerFormValues) => void | Promise<void>;
  pending: boolean;
  error: string | null;
}

/** `/admin/coop` (admins only): record a board decision appointing a worker member. */
export function AdminCoopPage({
  values,
  onValuesChange,
  onAppoint,
  pending,
  error,
}: AdminCoopPageProps): React.JSX.Element {
  return (
    <PageContainer data-testid="admin-coop" width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader size="compact" title={t("coop.admin.title")} description={t("coop.admin.intro")} />
      <SplitLayout
        asideWidth="lg"
        main={
          <AppointWorkerForm
            title={t("coop.admin.appointTitle")}
            description={t("coop.admin.appointIntro")}
            labels={{
              username: t("coop.admin.username"),
              usernameHint: t("coop.admin.usernameHint"),
              minute: t("coop.admin.minute"),
              minuteHint: t("coop.admin.minuteHint"),
              submit: t("coop.admin.appoint"),
            }}
            values={values}
            onValuesChange={onValuesChange}
            onSubmit={onAppoint}
            pending={pending}
            error={error ?? undefined}
            usernameProps={{ "data-testid": "appoint-worker-username" }}
            minuteProps={{ "data-testid": "appoint-worker-minute" }}
            submitProps={{ "data-testid": "appoint-worker-submit" }}
          />
        }
        aside={<AlertCallout tone="info" description={t("coop.admin.note")} />}
      />
    </PageContainer>
  );
}
