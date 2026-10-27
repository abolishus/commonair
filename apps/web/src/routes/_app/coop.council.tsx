// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CouncilPage } from "../../components/coop/council.tsx";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import { activeMemberClasses } from "../../components/coop/rules.ts";
import { coopLoads, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Public: the creator council, how it was seated, board seats and elections (members stand and vote). */
export const Route = createFileRoute("/_app/coop/council")({ component: CouncilRoute });

function CouncilRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const council = useCoopLoad("council", () => api().coop.council());
  const board = useCoopLoad("board", () => api().coop.board());
  const elections = useCoopLoad("elections", () => api().coop.elections.list());
  const membership = useMyMembership(me);
  return (
    <CoopLoadGate status={coopLoads([council, board, elections, membership])} tab="council">
      <CouncilPage
        council={council.data}
        board={board.data}
        elections={elections.data}
        meId={me?.id ?? null}
        classes={activeMemberClasses(membership.data)}
        onNominate={async (id, statement) => {
          await api().coop.elections.nominate({ id, statement });
          toast.success(t("coop.elections.nominated"));
          elections.reload();
        }}
        onVote={async (id, candidateIds) => {
          await api().coop.elections.vote({ id, candidateIds });
          toast.success(t("coop.elections.ballotCast"));
          elections.reload();
        }}
      />
    </CoopLoadGate>
  );
}
