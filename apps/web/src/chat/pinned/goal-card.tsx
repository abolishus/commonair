// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A goal's card in the expanded pinned strip: its title, state and progress bar. Viewers only
 * watch a goal fill; there is nothing to do with it, so the card has no controls.
 */
import { ProgressRow } from "@commonair/ui/blocks/data";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { GoalView } from "../interact/state.ts";
import { progressLabel, stateLabel, type PinnedItem } from "./model.ts";

export function GoalCard({ goal, item }: { goal: GoalView; item: PinnedItem }): React.JSX.Element {
  const progress = item.progress ?? { type: goal.type, current: goal.current, target: goal.target, percent: 0 };
  const ended = goal.endedAt !== null;
  return (
    <section
      data-testid="chat-goal"
      data-goal-id={goal.id}
      data-type={goal.type}
      data-state={item.state.phase}
      data-current={goal.current}
      data-target={goal.target}
      aria-label={t("chat.strip.kind.goal")}
      className="grid min-w-0 gap-2 border p-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="min-w-0 text-sm font-medium break-words">{goal.title}</h3>
        {ended && <span className="shrink-0 text-xs text-muted-foreground">{stateLabel(item)}</span>}
      </div>
      <ProgressRow
        label={t("chat.strip.goal.label")}
        value={progress.percent}
        tone={goal.achieved ? "success" : "default"}
        valueText={progressLabel(progress)}
      />
    </section>
  );
}
