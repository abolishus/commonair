// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { StatementPage } from "../../components/coop/statements.tsx";
import { coopLoads, isNotFound, useCoopLoad } from "../../components/coop/use-coop.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Signed in: one of your statements, explained line by line. */
export const Route = createFileRoute("/_app/coop/patronage/$periodId")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: StatementRoute,
});

function StatementRoute(): React.JSX.Element {
  const { periodId } = Route.useParams();
  const { me } = useBootstrap();
  const statement = useCoopLoad(periodId, () => api().coop.patronage.statement({ periodId }));
  if (!me) return <Navigate to="/signin" replace />;
  // Not yours, not approved, or no such period: the API answers NOT_FOUND alike.
  if (isNotFound(statement)) return <NotFoundState />;
  return (
    <CoopLoadGate status={coopLoads([statement])} tab="patronage">
      <StatementPage statement={statement.data} />
    </CoopLoadGate>
  );
}
