// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned strip's model (D2-chat, design review F6): the chat panel's prediction, poll,
 * giveaway and goals as one-line items, in priority order, with their state label and what a
 * screen reader hears when one changes. Pure, for unit tests.
 */
import { formatDuration, formatNumber } from "@commonair/ui";
import { activeLocale, t, type MessageKey } from "../../i18n/index.ts";
import {
  goalPercent,
  type GiveawayDto,
  type GoalView,
  type PollViewDto,
  type PredictionViewDto,
} from "../interact/state.ts";

export type PinnedKind = "prediction" | "poll" | "giveaway" | "goal";

/** Where an item is in its life; `open` is the only phase with a countdown. */
export type PinnedPhase =
  | { phase: "open" }
  | { phase: "locked" }
  | { phase: "won"; by: string }
  | { phase: "ended" }
  | { phase: "canceled" }
  | { phase: "closed" }
  | { phase: "drawn" }
  | { phase: "achieved" };

/** A goal's numbers, for its label and progress bar. */
export interface PinnedProgress {
  type: GoalView["type"];
  current: number;
  target: number;
  /** 0 to 100. */
  percent: number;
}

export interface PinnedItem {
  kind: PinnedKind;
  id: string;
  /** `kind:id`: stable across state changes, so the item's card stays mounted. */
  slot: string;
  /** `kind:id:status`: a dismissal holds until this changes. */
  key: string;
  title: string;
  state: PinnedPhase;
  /** When the open phase ends (epoch ms), for the countdown; null when it has no deadline. */
  endsAt: number | null;
  /** Goals only. */
  progress: PinnedProgress | null;
}

/** An open prediction first, then a poll, a giveaway, a goal; anything no longer open after those. */
const RANK: Readonly<Record<PinnedKind, number>> = { prediction: 0, poll: 1, giveaway: 2, goal: 3 };
const KINDS = Object.keys(RANK).length;

export function pinnedPriority(item: Pick<PinnedItem, "kind" | "state">): number {
  return (item.state.phase === "open" ? 0 : KINDS) + RANK[item.kind];
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

function predictionItem(p: PredictionViewDto): PinnedItem {
  let state: PinnedPhase;
  if (p.status === "active") state = { phase: "open" };
  else if (p.status === "locked") state = { phase: "locked" };
  else if (p.status === "canceled") state = { phase: "canceled" };
  else {
    const winner = p.outcomes.find((o) => o.id === p.winningOutcomeId);
    state = winner ? { phase: "won", by: winner.title } : { phase: "ended" };
  }
  return {
    kind: "prediction",
    id: p.id,
    slot: `prediction:${p.id}`,
    key: `prediction:${p.id}:${p.status}`,
    title: p.title,
    state,
    endsAt: p.status === "active" ? ms(p.locksAt) : null,
    progress: null,
  };
}

/** The ended poll's winner: the one choice with the most votes, when it has any and no tie. */
function pollWinner(p: PollViewDto): string | null {
  let best: PollViewDto["choices"][number] | null = null;
  let tied = false;
  for (const c of p.choices) {
    if (!best || c.votes > best.votes) {
      best = c;
      tied = false;
    } else if (c.votes === best.votes) tied = true;
  }
  return best && best.votes > 0 && !tied ? best.title : null;
}

function pollItem(p: PollViewDto): PinnedItem {
  const winner = p.status === "active" ? null : pollWinner(p);
  const state: PinnedPhase =
    p.status === "active" ? { phase: "open" } : winner ? { phase: "won", by: winner } : { phase: "ended" };
  return {
    kind: "poll",
    id: p.id,
    slot: `poll:${p.id}`,
    key: `poll:${p.id}:${p.status}`,
    title: p.title,
    state,
    endsAt: p.status === "active" ? ms(p.endsAt) : null,
    progress: null,
  };
}

function giveawayItem(g: GiveawayDto): PinnedItem {
  const state: PinnedPhase =
    g.status === "open"
      ? { phase: "open" }
      : g.status === "closed"
        ? { phase: "closed" }
        : g.status === "drawn"
          ? { phase: "drawn" }
          : { phase: "canceled" };
  return {
    kind: "giveaway",
    id: g.id,
    slot: `giveaway:${g.id}`,
    key: `giveaway:${g.id}:${g.status}`,
    title: g.title,
    state,
    endsAt: g.status === "open" ? ms(g.closesAt) : null,
    progress: null,
  };
}

function goalItem(g: GoalView): PinnedItem {
  const status = g.endedAt === null ? "running" : g.achieved ? "achieved" : "ended";
  const state: PinnedPhase =
    status === "running" ? { phase: "open" } : status === "achieved" ? { phase: "achieved" } : { phase: "ended" };
  return {
    kind: "goal",
    id: g.id,
    slot: `goal:${g.id}`,
    // Progress is not part of the key: a dismissed goal stays hidden while it fills, back when it ends.
    key: `goal:${g.id}:${status}`,
    title: g.title,
    state,
    endsAt: null,
    progress: { type: g.type, current: g.current, target: g.target, percent: goalPercent(g) },
  };
}

/** The panel's pinned items, highest priority first. Ties keep the kind order. */
export function pinnedItems(s: {
  prediction: PredictionViewDto | null;
  poll: PollViewDto | null;
  giveaway: GiveawayDto | null;
  goals?: readonly GoalView[];
}): PinnedItem[] {
  const items: PinnedItem[] = [];
  if (s.prediction) items.push(predictionItem(s.prediction));
  if (s.poll) items.push(pollItem(s.poll));
  if (s.giveaway) items.push(giveawayItem(s.giveaway));
  for (const g of s.goals ?? []) items.push(goalItem(g));
  return items.sort((a, b) => pinnedPriority(a) - pinnedPriority(b));
}

/** Items the viewer has not dismissed in this state. */
export function undismissed(items: readonly PinnedItem[], dismissed: ReadonlySet<string>): PinnedItem[] {
  return items.filter((i) => !dismissed.has(i.key));
}

const KIND_KEYS: Readonly<Record<PinnedKind, MessageKey>> = {
  prediction: "chat.strip.kind.prediction",
  poll: "chat.strip.kind.poll",
  giveaway: "chat.strip.kind.giveaway",
  goal: "chat.strip.kind.goal",
};

export const DISMISS_KEYS: Readonly<Record<PinnedKind, MessageKey>> = {
  prediction: "chat.strip.dismiss.prediction",
  poll: "chat.strip.dismiss.poll",
  giveaway: "chat.strip.dismiss.giveaway",
  goal: "chat.strip.dismiss.goal",
};

export function kindLabel(kind: PinnedKind): string {
  return t(KIND_KEYS[kind]);
}

/**
 * A goal's numbers ("12 / 50"). Tips goals count minor units and the goal carries no currency, so
 * they read as a percentage instead of a guessed amount.
 */
export function progressLabel(p: PinnedProgress): string {
  if (p.type === "tips") return t("chat.strip.goal.percent", { percent: p.percent });
  const locale = activeLocale();
  return t("chat.strip.goal.progress", {
    current: formatNumber(p.current, locale),
    target: formatNumber(p.target, locale),
  });
}

/**
 * The state as the strip shows it ("Open · 2:31 left", "Locked", "Won by Alpha", a running goal's
 * "12 / 50"). Without `nowMs` there is no countdown: that form is what gets announced, so a timer
 * tick never is.
 */
export function stateLabel(
  item: Pick<PinnedItem, "state" | "endsAt"> & { progress?: PinnedProgress | null },
  nowMs: number | null = null,
): string {
  const s = item.state;
  switch (s.phase) {
    case "open": {
      if (item.progress) return progressLabel(item.progress);
      if (nowMs === null || item.endsAt === null || item.endsAt <= nowMs) return t("chat.strip.state.open");
      return t("chat.strip.state.openLeft", { time: formatDuration((item.endsAt - nowMs) / 1000) });
    }
    case "locked":
      return t("chat.strip.state.locked");
    case "won":
      return t("chat.strip.state.won", { name: s.by });
    case "ended":
      return t("chat.strip.state.ended");
    case "canceled":
      return t("chat.strip.state.canceled");
    case "closed":
      return t("chat.strip.state.closed");
    case "drawn":
      return t("chat.strip.state.drawn");
    case "achieved":
      return t("chat.strip.state.achieved");
  }
}

/** What a screen reader hears for an item: its kind, state (no countdown) and title. */
export function announcement(item: PinnedItem): string {
  return t("chat.strip.announce", { kind: kindLabel(item.kind), state: stateLabel(item), title: item.title });
}

/**
 * The item to announce after a render: the highest-priority one whose state is new since `seen`
 * (the keys of the previous render). Null on the first render (what is already on screen when the
 * panel loads is not news) and when nothing changed.
 */
export function newsworthy(seen: ReadonlySet<string> | null, items: readonly PinnedItem[]): PinnedItem | null {
  if (seen === null) return null;
  return items.find((i) => !seen.has(i.key)) ?? null;
}
