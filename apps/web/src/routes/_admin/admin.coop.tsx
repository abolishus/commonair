// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppointWorkerFormValues } from "@commonair/ui/blocks/coop";
import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { AdminCoopPage } from "../../components/coop/admin.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { isSessionExpired, toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { appointError, isAdmin } from "../../lib/coop.ts";

/** Admins only: the `_admin` layout's guard answers everyone else with not-found. */
export const Route = createFileRoute("/_admin/admin/coop")({ component: AdminCoopRoute });

const EMPTY: AppointWorkerFormValues = { username: "", minute: "" };

function AdminCoopRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const [values, setValues] = React.useState<AppointWorkerFormValues>(EMPTY);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Client fallback for the layout guard (and for a session whose role changed).
  if (!isAdmin(me)) return <NotFoundState />;
  return (
    <AdminCoopPage
      values={values}
      onValuesChange={(next) => {
        setValues(next);
        setError(null);
      }}
      pending={pending}
      error={error}
      onAppoint={async ({ username, minute }) => {
        if (pending) return;
        setPending(true);
        setError(null);
        try {
          await api().coop.appointWorker({ username: username.toLowerCase(), boardMinuteRef: minute });
          toast.success(t("coop.admin.appointed", { username }));
          setValues(EMPTY);
        } catch (err) {
          if (isSessionExpired(err)) toastActionError(err, t("coop.admin.failed"));
          else setError(appointError(err));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
