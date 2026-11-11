// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D5-studio F25: every empty state on a studio page its owner can fill has a description and a
 * primary action (`empty-state-action`). A source check over the studio's components and routes
 * (NOT_OWNER_FILLABLE lists the empties that others fill or that fill themselves, each with why),
 * then the empties rendered the way `newbie` sees them: the action is there and does its job.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ContentBoard } from "@commonair/ui/blocks/studio";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CrewSplitList } from "../src/components/money/crew.tsx";
import { RevenueLedger, TIERS_FORM_ID } from "../src/components/money/revenue.tsx";
import { RelayTable } from "../src/components/relays.tsx";
import { FocusFormAction, StudioLinkAction } from "../src/components/studio/empty-action.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const WEB = join(import.meta.dirname, "..");
const REPO = join(WEB, "../..");

/** The studio's own pages and the components they render that this unit owns. */
const SCANNED = [
  "src/routes/_studio",
  "src/components/analytics",
  "src/components/studio",
  "src/components/mod",
  "src/components/attestations",
  "src/components/money/revenue.tsx",
  "src/components/money/crew.tsx",
  "src/components/studio-money",
  "src/components/relays.tsx",
  "src/components/content-manager.tsx",
  "src/components/stream-health-card.tsx",
  "src/components/bot-studio/commands-panel.tsx",
  "../../packages/ui/src/blocks/studio/content-board.tsx",
];

/** Empties the owner cannot fill from the page (keyed by the file and the title's key or label). */
const NOT_OWNER_FILLABLE: Readonly<Record<string, string>> = {
  "analytics-page.tsx|analytics.pending.title": "fills itself 24 h after the broadcast",
  "revenue.tsx|studio.trend.revenueEmpty": "viewers fill it; the ledger's empty state carries the tiers action",
  "stream-health-card.tsx|dashboard.health.healthy": "not empty: nothing is wrong",
  "activity-feed.tsx|studio.activity.empty": "viewers fill it while live",
  "held-queue.tsx|held.empty": "word filters fill it",
  "mod-view.tsx|held.empty": "word filters fill it",
  "mod-view.tsx|studio.mod.logEmpty": "moderators fill it by acting in chat",
  "panel.tsx|attestations.panel.empty.title": "signed automatically after each broadcast",
  "captions.tsx|lists.captions.emptyTrack":
    "the caption worker fills a track; a track with no speech has no cues to correct",
};

function files(path: string): string[] {
  const full = join(WEB, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

/** Each `<EmptyState …>` opening tag's attributes (to the first `>` outside braces). */
function emptyStates(code: string): string[] {
  const out: string[] = [];
  const start = /<EmptyState\b/g;
  for (let m = start.exec(code); m; m = start.exec(code)) {
    let depth = 0;
    let i = start.lastIndex;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(code.slice(start.lastIndex, i));
  }
  return out;
}

const titleKey = (attrs: string) =>
  /title=\{t\("([^"]+)"\)\}/.exec(attrs)?.[1] ?? /title=\{([^}]+)\}/.exec(attrs)?.[1]?.trim() ?? "?";

describe("every owner-fillable studio empty state has an action (source)", () => {
  const all = SCANNED.flatMap(files)
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) =>
      emptyStates(readFileSync(f, "utf8")).map((attrs) => ({
        id: `${relative(REPO, f).split("/").pop()}|${titleKey(attrs)}`,
        attrs,
      })),
    );

  it("finds the empties", () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  it.each(all.map((e) => [e.id, e.attrs] as const))("%s", (id, attrs) => {
    expect(attrs, id).toMatch(/\bdescription=/);
    if (id in NOT_OWNER_FILLABLE) return;
    expect(attrs, `${id} needs an action (or a NOT_OWNER_FILLABLE entry saying why not)`).toMatch(/\baction=/);
  });

  it("NOT_OWNER_FILLABLE has no stale entries", () => {
    const ids = new Set(all.map((e) => e.id));
    expect(Object.keys(NOT_OWNER_FILLABLE).filter((k) => !ids.has(k))).toEqual([]);
  });
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );
const action = () => screen.getByTestId("empty-state-action");

describe("the empties newbie sees (rendered)", () => {
  it("videos and clips point at recording and the stream manager", () => {
    wrap(
      <ContentBoard
        vods={[]}
        clips={[]}
        labels={
          {
            vods: "VODs",
            clips: "Clips",
            vodsEmptyTitle: t("content.vodsEmpty"),
            vodsEmptyDescription: t("content.vodsEmptyHint"),
            clipsEmptyTitle: t("content.clipsEmpty"),
            clipsEmptyDescription: t("content.clipsEmptyHint"),
          } as React.ComponentProps<typeof ContentBoard>["labels"]
        }
        onSaveVod={() => undefined}
        onDeleteVod={() => undefined}
        onDeleteClip={() => undefined}
        emptyActions={{
          vods: <StudioLinkAction to="/dashboard/settings">{t("studio.empty.turnOnRecording")}</StudioLinkAction>,
          clips: <StudioLinkAction to="/dashboard">{t("studio.empty.openStreamManager")}</StudioLinkAction>,
        }}
      />,
    );
    const links = screen.getAllByTestId("empty-state-action");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Save videos of my streams", "/dashboard/settings"],
      ["Open stream manager", "/dashboard"],
    ]);
  });

  it("relays: Add a relay focuses the name field", () => {
    wrap(
      <>
        <input id="relay-create-name" aria-label="Relay name" />
        <RelayTable
          relays={[]}
          onRemoved={() => undefined}
          emptyAction={<FocusFormAction selector="#relay-create-name">{t("studio.empty.addRelay")}</FocusFormAction>}
        />
      </>,
    );
    // happy-dom has no layout to scroll.
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
    fireEvent.click(action());
    expect(document.activeElement?.id).toBe("relay-create-name");
    expect(screen.getByTestId("relays-empty").textContent).toContain("Add a relay");
  });

  it("revenue: the empty ledger links to the tier form", () => {
    wrap(
      <RevenueLedger
        lines={[]}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => undefined}
        downloading={false}
        onDownload={() => undefined}
      />,
    );
    expect(action().getAttribute("href")).toBe(`#${TIERS_FORM_ID}`);
    expect(action().textContent).toBe("Set up subscription tiers");
  });

  it("crew: an empty list takes the owner's action; a list others fill has none", () => {
    const { unmount } = wrap(
      <CrewSplitList
        splits={[]}
        meId="me"
        canEnd
        empty={{
          title: "splits.mine.empty",
          hint: "splits.mine.emptyHint",
          action: <FocusFormAction selector="#x">{t("studio.empty.proposeSplit")}</FocusFormAction>,
        }}
        onAnswer={async () => undefined}
        onEnd={async () => undefined}
      />,
    );
    expect(action().textContent).toBe("Propose a split");
    unmount();
    wrap(
      <CrewSplitList
        splits={[]}
        meId="me"
        canEnd={false}
        empty={{ title: "splits.offered.empty", hint: "splits.offered.emptyHint" }}
        onAnswer={async () => undefined}
        onEnd={async () => undefined}
      />,
    );
    expect(screen.getByTestId("crew-empty")).toBeTruthy();
    expect(screen.queryByTestId("empty-state-action")).toBeNull();
  });
});
