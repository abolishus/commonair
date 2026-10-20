// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import { SubscriptionList } from "../../components/support/subscription-list.tsx";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import type { SubscriptionDto } from "../../lib/support.ts";

export const Route = createFileRoute("/_app/settings/subscriptions")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: SubscriptionsPage,
});

function SubscriptionsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const [subscriptions, setSubscriptions] = React.useState<SubscriptionDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    api()
      .money.mySubscriptions()
      .then((list) => {
        if (live) setSubscriptions(list);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const cancel = async (subscription: SubscriptionDto) => {
    const updated = await api().money.cancelSubscription({ id: subscription.id });
    setSubscriptions((list) => list?.map((s) => (s.id === updated.id ? updated : s)) ?? list);
    toast.success(t("subscriptions.cancelled"));
  };

  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer data-testid="subscriptions" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("subscriptions.title")} description={t("subscriptions.intro")} />
      {failed ? (
        <FormError>{t("subscriptions.loadFailed")}</FormError>
      ) : (
        <SubscriptionList
          subscriptions={subscriptions}
          onCancel={cancel}
          onCancelError={(err) => toastActionError(err, t("subscriptions.cancelFailed"))}
        />
      )}
    </PageContainer>
  );
}
