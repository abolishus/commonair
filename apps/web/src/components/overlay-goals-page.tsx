// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMoney, formatNumber, useLocale } from "@commonair/ui";
import { type GoalBarItem, OverlayGoalsView } from "@commonair/ui/blocks/interact-viewer";
import type { OverlayState } from "@commonair/ui/blocks/overlay";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { type OverlayConnectionDeps, type OverlayGoal, connectOverlay } from "../lib/overlay-connection.ts";
import { overlayTokenFrom } from "../lib/overlay-page.ts";
import { browserOverlayDeps } from "./overlay-alerts-page.tsx";

/** How long an achieved goal stays on screen, full, before it leaves. */
export const ACHIEVED_VISIBLE_MS = 6_000;

export interface GoalsState {
  /** Open goals and achieved ones still on screen, in arrival order. */
  goals: OverlayGoal[];
  /** Achieved goals' ids → when they leave (ms epoch). */
  leaving: Record<string, number>;
}

export const EMPTY_GOALS: GoalsState = { goals: [], leaving: {} };

export type GoalsAction =
  | { type: "loaded"; goals: readonly OverlayGoal[] }
  | { type: "goal"; goal: OverlayGoal; now: number }
  | { type: "expire"; now: number }
  | { type: "clear" };

export const isAchieved = (g: OverlayGoal): boolean => g.current >= g.target;

/**
 * The goals overlay's list. `loaded` (every (re)connect) replaces it with the open goals of the
 * state call; a `goal` frame updates or adds an open goal; an ended goal that was achieved stays
 * full for `ACHIEVED_VISIBLE_MS`, one that was not leaves at once. Pure.
 */
export function goalsReducer(state: GoalsState, action: GoalsAction): GoalsState {
  switch (action.type) {
    case "loaded": {
      const open = action.goals.filter((g) => g.endedAt === null);
      // Keep achieved goals still on their way out: the state call no longer lists them.
      const leaving = state.goals.filter((g) => g.id in state.leaving && !open.some((o) => o.id === g.id));
      return { goals: [...open, ...leaving], leaving: state.leaving };
    }
    case "goal": {
      const g = action.goal;
      const others = state.goals.filter((x) => x.id !== g.id);
      const at = state.goals.findIndex((x) => x.id === g.id);
      const place = (list: OverlayGoal[]) => (at < 0 ? [...list, g] : [...list.slice(0, at), g, ...list.slice(at)]);
      const leaving = Object.fromEntries(Object.entries(state.leaving).filter(([id]) => id !== g.id));
      if (g.endedAt === null) return { goals: place(others), leaving };
      if (!isAchieved(g)) return { goals: others, leaving };
      return {
        goals: place(others),
        leaving: { ...state.leaving, [g.id]: state.leaving[g.id] ?? action.now + ACHIEVED_VISIBLE_MS },
      };
    }
    case "expire": {
      const due = Object.entries(state.leaving)
        .filter(([, at]) => at <= action.now)
        .map(([id]) => id);
      if (due.length === 0) return state;
      const leaving = Object.fromEntries(Object.entries(state.leaving).filter(([id]) => !due.includes(id)));
      return { goals: state.goals.filter((g) => !due.includes(g.id)), leaving };
    }
    case "clear":
      return EMPTY_GOALS;
  }
}

/** The bar's text: counts for followers and subscriptions, money for tips (minor units). */
export function goalValueText(goal: OverlayGoal, currency: string, locale: string): string {
  const fmt = (n: number) => (goal.type === "tips" ? formatMoney(n, currency, locale) : formatNumber(n, locale));
  return t("overlayGoals.progress", { current: fmt(goal.current), target: fmt(goal.target) });
}

/** A URL without a token: refused at once, no request, no stream. */
function withoutToken(): OverlayConnectionDeps {
  return {
    loadState: () => Promise.reject(Object.assign(new Error("no overlay token"), { code: "UNAUTHORIZED" })),
    openEvents: () => {
      throw new Error("no overlay token");
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

type GoalsStateDto = { eventsUrl: string; goals?: readonly OverlayGoal[] };

/**
 * `/overlay/goals`: the token from the query string (browser only), `interact.overlays.state`
 * for the open goals, then `goal` frames from the overlay stream. Transparent and chrome-less;
 * `revoked` or a 401 ends it (`refused`), with nothing drawn.
 */
export function OverlayGoalsPage({
  currency,
  deps = browserOverlayDeps,
  reducedMotion,
}: {
  /** The instance currency, for tips goals (their amounts are its minor units). */
  currency: string;
  /** Tests pass a fake API and `EventSource`. */
  deps?: (token: string) => OverlayConnectionDeps<GoalsStateDto>;
  reducedMotion?: boolean;
}): React.JSX.Element {
  const { locale } = useLocale();
  const [state, setState] = React.useState<OverlayState>("connecting");
  const [goals, dispatch] = React.useReducer(goalsReducer, EMPTY_GOALS);
  const makeDeps = React.useRef(deps);

  React.useEffect(() => {
    const token = overlayTokenFrom(window.location.search);
    const connection: OverlayConnectionDeps<GoalsStateDto> = token ? makeDeps.current(token) : withoutToken();
    return connectOverlay(connection, {
      onState: setState,
      onLoaded: (s) => dispatch({ type: "loaded", goals: s.goals ?? [] }),
      onGoal: (goal) => dispatch({ type: "goal", goal, now: Date.now() }),
    });
  }, []);

  React.useEffect(() => {
    if (state === "refused") dispatch({ type: "clear" });
  }, [state]);

  // Achieved goals leave on time: one timer for the next one due.
  const nextDue = Math.min(...Object.values(goals.leaving));
  React.useEffect(() => {
    if (!Number.isFinite(nextDue)) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "expire", now: Date.now() }),
      Math.max(0, nextDue - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [nextDue]);

  const items: GoalBarItem[] = goals.goals.map((g) => ({
    id: g.id,
    type: g.type,
    title: g.title,
    current: g.current,
    target: g.target,
    valueText: goalValueText(g, currency, locale),
    achieved: g.id in goals.leaving,
  }));
  return <OverlayGoalsView state={state} goals={items} reducedMotion={reducedMotion} />;
}
