// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Smoke test for the page stories: every board's `Default` story renders under the providers the
 * Storybook decorator uses, exposes its `main` landmark (the dialog for Support) and logs no errors.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { LocaleProvider } from "../src/lib/locale.tsx";
import { TooltipProvider } from "../src/components/tooltip.tsx";

interface BoardModule {
  default: { title: string };
  Default: { render: () => React.ReactElement };
  Light: { globals?: Record<string, unknown> };
  Mobile320: { globals?: Record<string, unknown> };
}

const pagesDir = join(import.meta.dirname, "..", "stories", "pages");
const boards = await Promise.all(
  readdirSync(pagesDir)
    .filter((file) => file.endsWith(".stories.tsx"))
    .map(
      async (file) => [file.replace(".stories.tsx", ""), (await import(join(pagesDir, file))) as BoardModule] as const,
    ),
);

/** happy-dom does not know the HTML `<search>` landmark (HeaderSearch); real browsers do. */
const isHappyDomGap = (args: unknown[]): boolean =>
  args[0] ===
    "The tag <%s> is unrecognized in this browser. If you meant to render a React component, start its name with an uppercase letter." &&
  args[1] === "search";

const BOARDS = [
  "Main",
  "Browse",
  "Category",
  "Search",
  "Following",
  "SignIn",
  "Settings",
  "Channel",
  "ChannelAbout",
  "Vod",
  "Clip",
  "Support",
  "Mobile",
  "StreamManager",
  "StreamSetup",
  "Analytics",
  "Revenue",
  "Community",
  "ChatBot",
  "Content",
  "Overlays",
  "Coop",
  "Proposal",
  "Transparency",
  "Developer",
  "TrustSafety",
  "Status",
  "Finances",
  "Expenses",
  "Membership",
  "Proposals",
  "ProposalForm",
  "Council",
  "CoopSettings",
  "Statements",
  "TreasuryCoop",
  "AdminCoop",
];

/** Boards whose title differs from the file name (the viewer `Settings` board already owns that file name). */
const TITLE_NAMES: Record<string, string> = { CoopSettings: "Settings" };

beforeAll(() => {
  // Recharts measures its container; happy-dom has no layout engine.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page stories", () => {
  test("there is one story file per mockup board", () => {
    expect(boards.map(([name]) => name).sort()).toEqual([...BOARDS].sort());
  });

  test.each(boards)("%s exports Default, Light and Mobile320 under Pages/", (name, mod) => {
    const titleName = TITLE_NAMES[name] ?? name;
    expect(mod.default.title).toMatch(
      new RegExp(`^Pages/(Viewer|Channel|Creator studio|Co-op|Platform)/${titleName}$`),
    );
    expect(mod.Light.globals).toEqual({ theme: "light" });
    expect(mod.Mobile320.globals).toEqual({ viewport: { value: "mobile320", isRotated: false } });
  });

  test.each(boards)("%s renders its landmark without console errors", (name, mod) => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (!isHappyDomGap(args)) errors.push(args);
    });
    render(
      <LocaleProvider locale="en">
        <TooltipProvider>{mod.Default.render()}</TooltipProvider>
      </LocaleProvider>,
    );
    const landmarks = name === "Support" ? screen.getAllByRole("dialog") : screen.getAllByRole("main");
    expect(landmarks.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test("board titles are unique", () => {
  const titles = boards.map(([, mod]) => mod.default.title);
  expect(new Set(titles).size).toBe(titles.length);
});

describe("Support board matches the shipped dialog (manual adapter)", () => {
  const support = boards.find(([name]) => name === "Support")?.[1] as unknown as Record<
    string,
    { render: () => React.ReactElement } | undefined
  >;
  const show = (story: string) =>
    render(
      <LocaleProvider locale="en">
        <TooltipProvider>{support[story]?.render()}</TooltipProvider>
      </LocaleProvider>,
    );

  test("the form splits between creator and co-op only and has no card picker", () => {
    show("Default");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-accent")).toBe("teal");
    expect(screen.getByRole("tablist", { name: "Ways to support" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "90% to the creator, 10% to the co-op" })).toBeTruthy();
    expect(dialog.textContent).toContain("Creator$4.50 · 90%Co-op$0.49 · 10%");
    expect(dialog.textContent).not.toMatch(/processing|Pay with|Card ending/i);
    expect(screen.getByRole("button", { name: "Subscribe for $4.99 / month" })).toBeTruthy();
  });

  test("the instructions step shows the CA- reference and amount instead of the form", () => {
    show("Instructions");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/CA-[0-9A-HJKMNP-TV-Z]{8}/);
    expect(screen.getByRole("button", { name: "Copy reference" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  test("without tiers, sub and gift are disabled and described by the reason", () => {
    show("NoTiers");
    const reason = screen.getByText(/has not set up subscriptions/);
    for (const name of ["Subscribe", "Gift subs"]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.getAttribute("aria-describedby")).toBe(reason.id);
      expect(tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true").toBe(true);
    }
    expect(screen.getByRole("tab", { name: "Tip" }).getAttribute("aria-selected")).toBe("true");
  });
});

type StoryLike = { render: () => React.ReactElement };

describe("E5 co-op boards", () => {
  const COOP = ["Coop", "Proposal", "Transparency", ...BOARDS.slice(BOARDS.indexOf("Membership"))];
  const stories = (name: string): [string, StoryLike][] =>
    Object.entries(boards.find(([board]) => board === name)?.[1] ?? {}).filter(
      (entry): entry is [string, StoryLike] =>
        entry[0] !== "default" && typeof (entry[1] as { render?: unknown }).render === "function",
    );
  const show = (story: StoryLike | undefined) =>
    render(
      <LocaleProvider locale="en">
        <TooltipProvider>{story?.render()}</TooltipProvider>
      </LocaleProvider>,
    );

  test.each(COOP.flatMap((name) => stories(name).map(([story, mod]) => [`${name}/${story}`, mod] as const)))(
    "%s renders without console errors",
    (_id, story) => {
      const errors: unknown[][] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        if (!isHappyDomGap(args)) errors.push(args);
      });
      show(story);
      expect(screen.getAllByRole("main").length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    },
  );

  const proposal = Object.fromEntries(stories("Proposal"));
  const byId = (id: string) => screen.queryByTestId(id);

  test("voting shows the ballot and participation, never a tally", () => {
    show(proposal.Default);
    expect(byId("proposal")?.getAttribute("data-status")).toBe("voting");
    expect(byId("vote-panel")?.getAttribute("data-my-vote")).toBe("yes");
    expect(byId("vote-participation")?.getAttribute("data-eligible")).toBe("5637");
    expect(byId("tally")).toBeNull();
    expect(screen.queryAllByTestId("tally-row")).toHaveLength(0);
    expect(byId("council-response")?.getAttribute("data-stance")).toBe("oppose");
  });

  test("the rejected protected decision shows the tally per class and the failing check", () => {
    show(proposal.Rejected);
    expect(byId("vote-panel")).toBeNull();
    const tally = byId("tally");
    expect(tally?.getAttribute("data-passed")).toBe("false");
    expect(tally?.getAttribute("data-reason")).toBe("streamer-class majority not met");
    expect(screen.getAllByTestId("tally-row").map((row) => row.getAttribute("data-scope"))).toEqual([
      "member_wide",
      "streamer",
      "viewer",
      "worker",
    ]);
    const failed = screen
      .getAllByTestId("tally-check")
      .filter((check) => check.getAttribute("data-passed") === "false");
    expect(failed.map((check) => check.getAttribute("data-rule"))).toEqual(["streamer_class_majority"]);
  });

  test("council review shows the respond form to council members; drafts show author actions", () => {
    show(proposal.CouncilReview);
    expect(byId("council-respond")).toBeTruthy();
    expect(byId("proposal-comment-body")).toBeTruthy();
    cleanup();
    show(proposal.Draft);
    expect(byId("proposal-submit")).toBeTruthy();
    expect(byId("proposal-withdraw")).toBeTruthy();
    expect(byId("proposal-comment-body")).toBeNull();
    expect(byId("proposal-timeline-draft")?.getAttribute("data-state")).toBe("current");
    expect(byId("proposal-timeline-voting")?.getAttribute("data-at")).toBe("");
  });

  test("the membership board's buy flow reveals the manual instructions", async () => {
    const membership = Object.fromEntries(stories("Membership"));
    show(membership.NotMember);
    expect(byId("membership-share")?.getAttribute("data-status")).toBe("none");
    expect(byId("membership-share-instructions")).toBeNull();
    (byId("membership-buy-share") as HTMLButtonElement).click();
    expect(await screen.findByTestId("membership-share-instructions")).toBeTruthy();
    expect(byId("membership-buy-share")).toBeNull();
  });
});
