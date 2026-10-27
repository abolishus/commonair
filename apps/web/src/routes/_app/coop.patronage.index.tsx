// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { StatementsPage } from "../../components/coop/statements.tsx";
import { coopLoads, useCoopLoad } from "../../components/coop/use-coop.ts";
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
  const statements = useCoopLoad(me ? `statements|${me.id}` : "statements|-", () => api().coop.patronage.statements());
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <CoopLoadGate status={coopLoads([statements])} tab="patronage">
      <StatementsPage statements={statements.data} />
    </CoopLoadGate>
  );
}
