// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  OverlayGoalsView,
  ViewerPollCard,
  ViewerPredictionCard,
  type GoalBarItem,
  type ViewerPollChoice,
  type ViewerPredictionOutcome,
} from "../src/blocks/interact-viewer/index.ts";

const meta = { title: "Blocks/InteractViewer", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const votes = (n: number): string => (n === 1 ? "1 vote" : `${n} votes`);
const pollChoices = (counts: number[]): ViewerPollChoice[] =>
  ["Speedrun the boss", "Explore the caves", "Craft a new sword"].map((title, i) => ({
    id: `c${i + 1}`,
    title,
    votes: counts[i] ?? 0,
    votesLabel: votes(counts[i] ?? 0),
  }));

/** The card as it sits in the chat panel's pinned slot. */
function Pinned({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="max-w-sm border border-border bg-card p-2">{children}</div>;
}

function LivePoll(): React.JSX.Element {
  const [counts, setCounts] = React.useState([4, 2, 1]);
  const [mine, setMine] = React.useState<string | null>(null);
  const [extra, setExtra] = React.useState(0);
  const choices = pollChoices(counts);
  return (
    <Pinned>
      <ViewerPollCard
        pollId="p1"
        status="active"
        title="What should we do next?"
        heading="Poll"
        meta="Ends in 42 seconds"
        choices={choices}
        canVote
        myVote={mine ? { choiceId: mine, votes: 1, label: "You voted" } : null}
        onVote={(id) => {
          setCounts((c) => c.map((n, i) => (`c${i + 1}` === id ? n + 1 + extra : n)));
          setMine(id);
          setExtra(0);
        }}
        extra={{
          value: extra,
          max: 100,
          onValueChange: setExtra,
          label: "Extra votes",
          costLabel: `${extra * 20} points`,
        }}
        liveSummary={choices.map((c) => `${c.title}: ${c.votesLabel}`).join(", ")}
        toggleLabel="Show or hide the poll"
      />
    </Pinned>
  );
}

export const Poll: Story = { render: () => <LivePoll /> };
export const PollLight: Story = { render: () => <LivePoll />, globals: { theme: "light" } };
export const PollMobile320: Story = { render: () => <LivePoll />, globals: { viewport: { value: "mobile320" } } };
export const PollResultsSignedOut: Story = {
  render: () => (
    <Pinned>
      <ViewerPollCard
        pollId="p1"
        status="completed"
        title="What should we do next?"
        heading="Poll results"
        meta="7 votes"
        choices={pollChoices([4, 2, 1])}
        canVote={false}
        myVote={null}
        hint="Sign in to vote in polls."
        liveSummary=""
        toggleLabel="Show or hide the poll"
      />
    </Pinned>
  ),
};

const outcomes = (winner?: string): ViewerPredictionOutcome[] =>
  [
    { id: "o1", title: "Boss down first try", points: 1200, users: 5 },
    { id: "o2", title: "Takes a few tries", points: 600, users: 3 },
  ].map((o) => ({
    ...o,
    summary: `${o.points.toLocaleString("en")} points · ${o.users} viewers`,
    betLabel: `Bet on “${o.title}”`,
    winner: winner === o.id,
  }));

function OpenPrediction(): React.JSX.Element {
  const [amount, setAmount] = React.useState("100");
  return (
    <Pinned>
      <ViewerPredictionCard
        predictionId="pr1"
        status="active"
        title="Will the boss go down first try?"
        heading="Prediction"
        meta="Betting closes in 1 minute"
        outcomes={outcomes()}
        canBet
        amount={{ value: amount, onValueChange: setAmount, min: 1, max: 850, label: "Points to bet" }}
        myBet={null}
        liveSummary="Boss down first try: 1,200 points. Takes a few tries: 600 points."
        toggleLabel="Show or hide the prediction"
      />
    </Pinned>
  );
}

export const Prediction: Story = { render: () => <OpenPrediction /> };
export const PredictionLight: Story = { render: () => <OpenPrediction />, globals: { theme: "light" } };
export const PredictionMobile320: Story = {
  render: () => <OpenPrediction />,
  globals: { viewport: { value: "mobile320" } },
};
export const PredictionResolved: Story = {
  render: () => (
    <Pinned>
      <ViewerPredictionCard
        predictionId="pr1"
        status="resolved"
        title="Will the boss go down first try?"
        heading="Prediction result"
        meta="Boss down first try won"
        outcomes={outcomes("o1")}
        canBet
        myBet={{ outcomeId: "o1", points: 100, payout: 150, label: "You bet 100 points and won 150 points." }}
        liveSummary=""
        toggleLabel="Show or hide the prediction"
      />
    </Pinned>
  ),
};

/** A stand-in stream frame behind the transparent overlay. */
function Stage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="bg-linear-to-br from-chart-1 via-muted to-chart-4">{children}</div>;
}

function Goals({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const [current, setCurrent] = React.useState(3);
  React.useEffect(() => {
    const timer = setInterval(() => setCurrent((c) => (c >= 10 ? 3 : c + 1)), 1500);
    return () => clearInterval(timer);
  }, []);
  const goals: GoalBarItem[] = [
    {
      id: "g1",
      type: "followers",
      title: "Follower goal",
      current,
      target: 10,
      valueText: `${current} / 10`,
      achieved: current >= 10,
    },
    { id: "g2", type: "tips", title: "New microphone", current: 2_450, target: 15_000, valueText: "$24.50 / $150.00" },
  ];
  return (
    <Stage>
      <OverlayGoalsView state="live" goals={goals} reducedMotion={reducedMotion} />
    </Stage>
  );
}

export const GoalsOverlay: Story = { render: () => <Goals />, parameters: { layout: "fullscreen" } };
export const GoalsOverlayReducedMotion: Story = {
  render: () => <Goals reducedMotion />,
  parameters: { layout: "fullscreen" },
};
export const GoalsOverlayMobile320: Story = {
  render: () => <Goals />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "mobile320" } },
};
