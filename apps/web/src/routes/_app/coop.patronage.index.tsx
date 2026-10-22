// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { StatementsPage } from "../../components/coop/statements.tsx";
import { FormError } from "../../components/form-error.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Signed in: your patronage statements. */
export const Route = createFileRoute("/_app/coop/patronage/")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: PatronageRoute,
});

function PatronageRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const statements = useLoad(me ? `statements|${me.id}` : "statements|-", () => api().coop.patronage.statements());
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <>
      {statements.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <StatementsPage statements={statements.data ?? (statements.failed ? [] : null)} />
    </>
  );
}
