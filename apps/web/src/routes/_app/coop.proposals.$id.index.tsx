// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup } from "@commonair/ui";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { CoopLoadError, CoopLoadGate } from "../../components/coop/load-error.tsx";
import { ProposalPage } from "../../components/coop/proposal.tsx";
import { coopLoads, isNotFound, toastCoopError, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { usePaged } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import {
  PROPOSAL_POLL_MS,
  changesOnItsOwn,
  isMember,
  voteRefusal,
  type CouncilStance,
  type VoteChoice,
} from "../../lib/coop.ts";

/** Public: one proposal with its timeline, discussion, council response, ballot and tally. */
export const Route = createFileRoute("/_app/coop/proposals/$id/")({ component: ProposalRoute });

const COMMENTS_PAGE = 50;

function ProposalRoute(): React.JSX.Element {
  const { id } = Route.useParams();
  // Keyed by id so per-proposal state (drafts, the closed-vote notice) never leaks across navigations.
  return <ProposalView key={id} id={id} />;
}

function ProposalView({ id }: { id: string }): React.JSX.Element {
  const { me } = useBootstrap();
  const proposal = useCoopLoad(id, () => api().coop.proposals.get({ id }));
  const comments = usePaged(
    `comments|${id}`,
    (cursor) => api().coop.proposals.comments({ id, limit: COMMENTS_PAGE, cursor }),
    toastCoopError,
  );
  const membership = useMyMembership(me);
  const council = useCoopLoad("council", () => api().coop.council());
  const [now, setNow] = React.useState(() => Date.now());
  const [closedNotice, setClosedNotice] = React.useState(false);

  const status = proposal.data?.status ?? null;
  const reload = proposal.reload;
  // Poll while the worker can move the proposal on, so the ballot never outlives its window.
  React.useEffect(() => {
    if (status === null || !changesOnItsOwn(status)) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      reload();
    }, PROPOSAL_POLL_MS);
    return () => clearInterval(timer);
  }, [status, reload]);

  if (isNotFound(proposal)) return <NotFoundState />;
  // Only the proposal gates the page: comments, membership and council feed parts of it, and
  // their failures show inline next to those parts.
  const loads = coopLoads([proposal]);
  const inline = (load: { failed: boolean; reload: () => void }) =>
    load.failed ? <CoopLoadError onRetry={load.reload} /> : null;
  const p = proposal.data;
  if (!p || loads.failed)
    return (
      <CoopLoadGate status={loads} tab="proposals">
        <PageContainer width="wide" className="py-8">
          <SkeletonGroup label={t("coop.loading")}>
            <div className="flex flex-col gap-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          </SkeletonGroup>
        </PageContainer>
      </CoopLoadGate>
    );

  const after = async (run: () => Promise<unknown>, done?: string) => {
    await run();
    if (done) toast.success(done);
    proposal.reload();
  };

  return (
    <CoopLoadGate status={loads} tab="proposals">
      <ProposalPage
        proposal={p}
        comments={comments.items}
        hasMoreComments={comments.hasMore}
        loadingMoreComments={comments.loadingMore}
        onLoadMoreComments={comments.loadMore}
        meId={me?.id ?? null}
        member={isMember(membership.data)}
        councilMember={me !== null && (council.data?.members.some((m) => m.user.id === me.id) ?? false)}
        now={now}
        votingClosed={closedNotice && p.status === "voting"}
        onActionError={toastCoopError}
        commentsError={inline(comments)}
        memberError={inline(membership)}
        councilError={inline(council)}
        onSubmitProposal={() => after(() => api().coop.proposals.submit({ id }), t("coop.proposal.submitted"))}
        onWithdraw={() => after(() => api().coop.proposals.withdraw({ id }), t("coop.proposal.withdrawn"))}
        onComment={async (body) => {
          await api().coop.proposals.comment({ id, body });
          comments.reload();
        }}
        onCouncilRespond={(value: { stance: CouncilStance; body: string }) =>
          after(() => api().coop.proposals.councilRespond({ id, ...value }), t("coop.council.responded"))
        }
        onVote={async (choice: VoteChoice) => {
          try {
            await after(() => api().coop.proposals.vote({ id, choice }), t("coop.vote.recorded"));
          } catch (err) {
            const refusal = voteRefusal(err);
            if (refusal === "voting_closed") {
              // The window closed under the open page: drop the ballot and fetch the new state.
              setClosedNotice(true);
              setNow(Date.now());
              toast.error(t("coop.vote.closedToast"));
              proposal.reload();
            } else if (refusal === "not_in_electorate") {
              toast.error(t("coop.vote.notInElectorate"));
              proposal.reload();
            } else throw err;
          }
        }}
      />
    </CoopLoadGate>
  );
}
