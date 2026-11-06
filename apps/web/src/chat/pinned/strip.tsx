// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned strip (`chat-pinned-strip`, design review F6): one line at the top of the chat log
 * for the highest-priority prediction, poll, giveaway or goal, with a "+N" chip when there are more.
 * The line expands the full cards inline, pushing the log down. The cards stay mounted while the
 * strip is collapsed, so a half-typed bet or a grace-window countdown survives a collapse.
 */
import { IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Progress } from "@commonair/ui/components/progress";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  ChartBarLineIcon,
  Flag02Icon,
  GiftIcon,
  Target02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  DISMISS_KEYS,
  announcement,
  kindLabel,
  newsworthy,
  stateLabel,
  type PinnedItem,
  type PinnedKind,
} from "./model.ts";

const ICONS: Readonly<Record<PinnedKind, IconSvgElement>> = {
  prediction: Target02Icon,
  poll: ChartBarLineIcon,
  giveaway: GiftIcon,
  goal: Flag02Icon,
};

/**
 * The wall clock for the open item's countdown: read on every render, and a render every second
 * while `active`, so the label never shows a time from before the item opened.
 */
function useNow(active: boolean, now: () => number): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now();
}

/**
 * The text of the polite announcement for the pinned items: set once when an item appears or
 * changes state, never for a countdown tick. Until `ready` (the panel's first load of the current
 * poll, prediction and giveaway) nothing is news: that is what was already there.
 */
export function usePinnedAnnouncement(items: readonly PinnedItem[], ready: boolean): string {
  const keys = items.map((i) => i.key);
  const sig = `${ready ? "1" : "0"}|${keys.join("|")}`;
  const [st, setSt] = React.useState(() => ({ sig, ready, seen: new Set(keys), text: "" }));
  if (st.sig !== sig) {
    // Both renders ready: the load and its result can land in one batched render, and that is not news.
    const news = ready && st.ready ? newsworthy(st.seen, items) : null;
    setSt({ sig, ready, seen: new Set(keys), text: news ? announcement(news) : st.text });
  }
  return st.text;
}

/** A goal's bar on the one line, only where the column has room (the label carries the numbers). */
function MiniBar({ percent }: { percent: number }): React.JSX.Element {
  return (
    <Progress
      value={percent}
      aria-hidden
      data-part="bar"
      data-percent={percent}
      className="hidden w-12 shrink-0 @xs/strip:flex"
    />
  );
}

export interface PinnedStripProps {
  /** The items to show, highest priority first, already without the dismissed ones. Not empty. */
  items: readonly PinnedItem[];
  /** The full card for an item. */
  renderCard: (item: PinnedItem) => React.ReactNode;
  onDismiss: (item: PinnedItem) => void;
  /** The wall clock (ms); tests pass a fake. */
  now?: () => number;
}

const systemNow = () => Date.now();

export function PinnedStrip({ items, renderCard, onDismiss, now = systemNow }: PinnedStripProps): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const regionId = React.useId();
  const toggleRef = React.useRef<HTMLButtonElement | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // A listener, not a JSX handler: Escape from anywhere in the strip (a card's field included)
  // folds the cards back into the line and returns focus to it.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || !expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setExpanded(false);
      toggleRef.current?.focus();
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [expanded]);
  const top = items[0];
  const nowMs = useNow(top?.state.phase === "open" && top.endsAt !== null, now);
  const more = items.length - 1;
  return (
    <div
      ref={rootRef}
      data-testid="chat-pinned-strip"
      data-kind={top?.kind}
      data-state={top?.state.phase}
      data-count={items.length}
      data-expanded={expanded ? "true" : "false"}
      className="@container/strip grid min-w-0 gap-2"
    >
      {top && (
        <div className="flex min-w-0 items-center gap-1">
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="sm"
            data-part="toggle"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => setExpanded((x) => !x)}
            className="h-auto min-h-7 min-w-0 flex-1 justify-start gap-2 py-1 text-start"
          >
            <HugeiconsIcon
              icon={ICONS[top.kind]}
              strokeWidth={2}
              aria-hidden
              className="size-4 text-muted-foreground"
            />
            <span className="sr-only">{kindLabel(top.kind)}</span>
            <span data-part="title" className="min-w-0 truncate font-medium">
              {top.title}
            </span>
            {top.progress && <MiniBar percent={top.progress.percent} />}
            <span data-part="state" className="shrink-0 text-muted-foreground tabular-nums">
              {stateLabel(top, nowMs)}
            </span>
            {more > 0 && (
              <span data-part="more" className="shrink-0 bg-muted px-1.5 text-muted-foreground tabular-nums">
                <span aria-hidden>{t("chat.strip.more", { count: more })}</span>
                <span className="sr-only">{t("chat.strip.moreLabel", { count: more })}</span>
              </span>
            )}
            <HugeiconsIcon
              icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
              strokeWidth={2}
              aria-hidden
              className="ms-auto size-4"
            />
          </Button>
          <IconButton
            size="icon-xs"
            icon={Cancel01Icon}
            label={t(DISMISS_KEYS[top.kind])}
            data-part="dismiss"
            onClick={() => onDismiss(top)}
          />
        </div>
      )}
      {/* Bounded so open cards never squeeze the log out of the column; tighter below lg, where the
          column is h-112 and also holds the header and the composer. */}
      <div
        id={regionId}
        data-part="cards"
        hidden={!expanded}
        className="grid max-h-48 min-w-0 lg:max-h-96 gap-3 overflow-y-auto"
      >
        {items.map((item) => (
          <React.Fragment key={item.slot}>{renderCard(item)}</React.Fragment>
        ))}
      </div>
    </div>
  );
}
