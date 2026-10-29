// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { POLL_RULES } from "@commonair/contracts/enums";
import { RelativeTime, formatNumber, useLocale } from "@commonair/ui";
import { ViewerPollCard } from "@commonair/ui/blocks/interact-viewer";
import * as React from "react";
import { type MessageKey, t } from "../../i18n/index.ts";
import { type InteractClient, interactErrorKey } from "./client.ts";
import { type LoyaltyBalanceDto, type PollViewDto } from "./state.ts";

export interface ChatPollCardProps {
  poll: PollViewDto;
  signedIn: boolean;
  /** The viewer's points when signed in and the channel's points are on; null otherwise. */
  points: LoyaltyBalanceDto | null;
  client: InteractClient;
  onVoted: (poll: PollViewDto) => void;
  onPointsSpent: () => void;
}

const ENDED: Record<Exclude<PollViewDto["status"], "active">, MessageKey> = {
  completed: "chatPoll.ended",
  terminated: "chatPoll.terminated",
  archived: "chatPoll.ended",
};

/**
 * The poll pinned above the chat log (`chat-poll`): one click votes; when the poll sells extra
 * votes and the channel's points are on, the extra-votes field shows their cost in points.
 * Signed-out viewers see the counts and a sign-in hint.
 */
export function ChatPollCard({
  poll,
  signedIn,
  points,
  client,
  onVoted,
  onPointsSpent,
}: ChatPollCardProps): React.JSX.Element {
  const { locale } = useLocale();
  const [extra, setExtra] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<MessageKey | null>(null);

  const active = poll.status === "active";
  const total = poll.choices.reduce((sum, c) => sum + c.votes, 0);
  // The server's cap is per viewer per poll, so votes already bought count against it.
  const extraLeft = POLL_RULES.maxExtraVotesPerUser - Math.max(0, poll.myVotes - 1);
  const sellsVotes = poll.pointsPerExtraVote > 0 && points !== null && extraLeft > 0;

  const vote = async (choiceId: string) => {
    setPending(true);
    setError(null);
    try {
      const view = await client.vote({
        id: poll.id,
        choiceId,
        extraVotes: sellsVotes ? Math.min(extra, extraLeft) : 0,
      });
      onVoted(view);
      setExtra(0);
      onPointsSpent();
    } catch (err) {
      setError(interactErrorKey(err, "poll"));
    } finally {
      setPending(false);
    }
  };

  const totalText = t("chatPoll.totalVotes", { count: total });
  const meta =
    poll.status === "active" ? (
      <>
        {t("chatPoll.endsIn")} <RelativeTime date={poll.endsAt} tooltip={false} /> · {totalText}
      </>
    ) : (
      `${t(ENDED[poll.status])} · ${totalText}`
    );

  return (
    <ViewerPollCard
      pollId={poll.id}
      status={poll.status}
      title={poll.title}
      heading={active ? t("chatPoll.title") : t("chatPoll.results")}
      meta={meta}
      choices={poll.choices.map((c) => ({ ...c, votesLabel: t("chatPoll.votes", { count: c.votes }) }))}
      myVote={
        poll.myVote
          ? { choiceId: poll.myVote, votes: poll.myVotes, label: t("chatPoll.voted", { count: poll.myVotes }) }
          : null
      }
      canVote={signedIn && active && !pending}
      onVote={(id) => void vote(id)}
      extra={
        sellsVotes && points
          ? {
              value: extra,
              max: extraLeft,
              onValueChange: setExtra,
              label: t("chatPoll.extraVotes"),
              costLabel: t("chatPoll.extraCost", {
                points: formatNumber(extra * poll.pointsPerExtraVote, locale),
                each: formatNumber(poll.pointsPerExtraVote, locale),
                name: points.pointsName,
              }),
            }
          : null
      }
      error={error ? t(error) : undefined}
      hint={signedIn ? undefined : t("chatPoll.signIn")}
      liveSummary={poll.choices.map((c) => t("chatPoll.choiceSummary", { title: c.title, count: c.votes })).join(", ")}
      toggleLabel={t("chatPoll.toggle")}
    />
  );
}
