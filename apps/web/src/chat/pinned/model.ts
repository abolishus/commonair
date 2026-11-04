// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned strip's model (D2-chat, design review F6): the chat panel's prediction, poll and
 * giveaway as one-line items, in priority order, with their state label and what a screen reader
 * hears when one changes. Pure, for unit tests.
 */
import { formatDuration } from "@commonair/ui";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { GiveawayDto, PollViewDto, PredictionViewDto } from "../interact/state.ts";

export type PinnedKind = "prediction" | "poll" | "giveaway";

/** Where an item is in its life; `open` is the only phase with a countdown. */
export type PinnedPhase =
  | { phase: "open" }
  | { phase: "locked" }
  | { phase: "won"; by: string }
  | { phase: "ended" }
  | { phase: "canceled" }
  | { phase: "closed" }
  | { phase: "drawn" };

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
}

/** An open prediction first, then a poll, then a giveaway; anything no longer open after those. */
const RANK: Readonly<Record<PinnedKind, number>> = { prediction: 0, poll: 1, giveaway: 2 };

export function pinnedPriority(item: Pick<PinnedItem, "kind" | "state">): number {
  return (item.state.phase === "open" ? 0 : 3) + RANK[item.kind];
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
  };
}

/** The panel's pinned items, highest priority first. Ties keep the kind order. */
export function pinnedItems(s: {
  prediction: PredictionViewDto | null;
  poll: PollViewDto | null;
  giveaway: GiveawayDto | null;
}): PinnedItem[] {
  const items: PinnedItem[] = [];
  if (s.prediction) items.push(predictionItem(s.prediction));
  if (s.poll) items.push(pollItem(s.poll));
  if (s.giveaway) items.push(giveawayItem(s.giveaway));
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
};

export const DISMISS_KEYS: Readonly<Record<PinnedKind, MessageKey>> = {
  prediction: "chat.strip.dismiss.prediction",
  poll: "chat.strip.dismiss.poll",
  giveaway: "chat.strip.dismiss.giveaway",
};

export function kindLabel(kind: PinnedKind): string {
  return t(KIND_KEYS[kind]);
}

/**
 * The state as the strip shows it ("Open · 2:31 left", "Locked", "Won by Alpha"). Without `nowMs`
 * there is no countdown: that form is what gets announced, so a timer tick never is.
 */
export function stateLabel(item: Pick<PinnedItem, "state" | "endsAt">, nowMs: number | null = null): string {
  const s = item.state;
  switch (s.phase) {
    case "open": {
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
