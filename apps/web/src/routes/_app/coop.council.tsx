// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CouncilPage } from "../../components/coop/council.tsx";
import { CoopSectionError } from "../../components/coop/load-error.tsx";
import { activeMemberClasses } from "../../components/coop/rules.ts";
import { useCoopLoad, useMyMembership, type CoopRetryable } from "../../components/coop/use-coop.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Public: the creator council, how it was seated, board seats and elections (members stand and vote). */
export const Route = createFileRoute("/_app/coop/council")({
  head: () => titleHead(t("pageTitle.coopCouncil")),
  component: CouncilRoute,
});

function CouncilRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const council = useCoopLoad("council", () => api().coop.council());
  const board = useCoopLoad("board", () => api().coop.board());
  const elections = useCoopLoad("elections", () => api().coop.elections.list());
  const membership = useMyMembership(me);
  // F3: each section fails on its own; the header, intro and every loaded section stay.
  const alone = [council, board, elections].every((l) => l.state === "failed");
  const error = (load: CoopRetryable, section: string) =>
    load.state === "failed" ? <CoopSectionError section={section} load={load} alone={alone} /> : null;
  return (
    // Public page: the caller's membership only decides who may stand and vote, so its failure
    // shows inline in the elections section.
    <CouncilPage
      council={council.data}
      board={board.data}
      elections={elections.data}
      meId={me?.id ?? null}
      classes={membership.state === "loaded" ? activeMemberClasses(membership.data) : null}
      membershipError={membership.failed ? <CoopSectionError section={t("coop.card.title")} load={membership} /> : null}
      sectionErrors={{
        council: error(council, t("coop.council.title")),
        method: error(council, t("coop.council.methodTitle")),
        board: error(board, t("coop.board.title")),
        elections: error(elections, t("coop.elections.title")),
      }}
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
  );
}
