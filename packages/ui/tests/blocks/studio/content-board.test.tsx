// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-content: the content library (cards, sort, the edit sheet, confirmed deletes, copy link) and
 * the overlay links panel's three links with their browser-source sizes.
 */
import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vite-plus/test";
import { CONTENT_SORTS, ContentBoard, sortContent } from "../../../src/blocks/studio/content-board.tsx";
import {
  OVERLAY_KINDS,
  OVERLAY_SIZES,
  OverlayTokenPanel,
  overlayUrlTestId,
} from "../../../src/blocks/studio/overlay-token.tsx";
import { TooltipProvider } from "../../../src/components/tooltip.tsx";
import { clips, contentLabels, overlayTokenLabels, overlayUrls, vods } from "../../../stories/e6-fixtures.tsx";

const withTooltips = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;
const attr = (el: Element, name: string) => el.getAttribute(name);
const vodRow = (id: string): HTMLElement => {
  const row = screen.getAllByTestId("vod-row").find((r) => attr(r, "data-vod-id") === id);
  if (!row) throw new Error(`no vod-row ${id}`);
  return row;
};

describe("sortContent", () => {
  const items = [
    { id: "a", createdAt: "2026-11-01T00:00:00Z", views: 5, clips: 0 },
    { id: "b", createdAt: "2026-11-03T00:00:00Z", views: 1, clips: 2 },
    { id: "c", createdAt: "2026-11-02T00:00:00Z", views: 5, clips: 2 },
    { id: "d", createdAt: "2026-11-02T00:00:00Z" },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  test("newest first, ties by id", () => {
    expect(ids(sortContent(items, "newest"))).toEqual(["b", "c", "d", "a"]);
  });
  test("most watched, then newest; missing counts are zero", () => {
    expect(ids(sortContent(items, "views"))).toEqual(["c", "a", "b", "d"]);
  });
  test("most clipped, then newest", () => {
    expect(ids(sortContent(items, "clips"))).toEqual(["b", "c", "d", "a"]);
  });
  test("an empty list and the input left alone", () => {
    expect(sortContent([], "views")).toEqual([]);
    const copy = [...items];
    sortContent(items, "views");
    expect(items).toEqual(copy);
    expect(CONTENT_SORTS).toEqual(["newest", "views", "clips"]);
  });
});

describe("ContentBoard", () => {
  const renderBoard = (props: Partial<React.ComponentProps<typeof ContentBoard>> = {}) => {
    const handlers = {
      onSaveVod: vi.fn<(id: string, update: { title: string; visibility: string }) => void>(),
      onDeleteVod: vi.fn<(id: string) => void>(),
      onDeleteClip: vi.fn<(id: string) => void>(),
      onCopyLink: vi.fn<(kind: "vod" | "clip", id: string) => void>(),
    };
    const view = render(
      withTooltips(<ContentBoard vods={vods} clips={clips} labels={contentLabels} {...handlers} {...props} />),
    );
    return { ...handlers, ...view };
  };

  test("video cards carry id, visibility and status, with thumbnail facts", () => {
    renderBoard();
    const rows = screen.getAllByTestId("vod-row");
    expect(
      rows.map((row) => [attr(row, "data-vod-id"), attr(row, "data-visibility"), attr(row, "data-status")]),
    ).toEqual([
      // Newest first.
      ["v2", "subscribers", "processing"],
      ["v1", "public", "ready"],
    ]);
    const ready = vodRow("v1");
    const processing = vodRow("v2");
    expect(ready.textContent).toContain("312 views");
    expect(ready.textContent).toContain("1 clip");
    expect(ready.textContent).toContain("Public");
    expect(ready.textContent).toContain("3:14:09");
    // Ready: the title links to the watch page; processing: no link, a status badge.
    expect(within(ready).getByRole("link").getAttribute("href")).toBe("/fernsby/vods/v1");
    expect(within(processing).queryByRole("link")).toBeNull();
    expect(processing.textContent).toContain("Processing");
    expect(within(ready).getByTestId("vod-copy-link")).toBeTruthy();
    expect(within(processing).queryByTestId("vod-copy-link")).toBeNull();
    // Cards are list items of a labelled list.
    expect(screen.getByRole("list", { name: "Past broadcasts" })).toBeTruthy();
  });

  test("edit opens the sheet: rename and re-scope, then save", async () => {
    const { onSaveVod } = renderBoard();
    const user = userEvent.setup();
    await user.click(within(vodRow("v1")).getByTestId("vod-edit"));
    const sheet = await screen.findByTestId("vod-edit-sheet");
    expect(attr(sheet, "data-vod-id")).toBe("v1");
    const save = within(sheet).getByTestId("vod-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const title = within(sheet).getByTestId("vod-title");
    await user.clear(title);
    await user.type(title, "  Renamed ");
    await user.click(within(sheet).getByRole("combobox", { name: "Visibility" }));
    await user.click(await screen.findByTestId("vod-visibility-option-private"));
    expect(attr(within(sheet).getByTestId("vod-visibility"), "data-value")).toBe("private");
    await user.click(save);
    expect(onSaveVod).toHaveBeenCalledWith("v1", { title: "Renamed", visibility: "private" });
  });

  test("an empty title cannot be saved", async () => {
    renderBoard();
    const user = userEvent.setup();
    await user.click(within(vodRow("v1")).getByTestId("vod-edit"));
    const sheet = await screen.findByTestId("vod-edit-sheet");
    await user.clear(within(sheet).getByTestId("vod-title"));
    expect((within(sheet).getByTestId("vod-save") as HTMLButtonElement).disabled).toBe(true);
    expect(sheet.textContent).toContain("Write a title.");
  });

  test("a failed save keeps the sheet open and reports the error", async () => {
    const onError = vi.fn<(e: unknown) => void>();
    renderBoard({ onSaveVod: () => Promise.reject(new Error("no")), onError });
    const user = userEvent.setup();
    await user.click(within(vodRow("v1")).getByTestId("vod-edit"));
    const sheet = await screen.findByTestId("vod-edit-sheet");
    await user.type(within(sheet).getByTestId("vod-title"), "!");
    await user.click(within(sheet).getByTestId("vod-save"));
    expect(onError).toHaveBeenCalledOnce();
    expect(screen.getByTestId("vod-edit-sheet")).toBeTruthy();
  });

  test("delete a video asks first", async () => {
    const { onDeleteVod } = renderBoard();
    const user = userEvent.setup();
    await user.click(within(vodRow("v2")).getByTestId("vod-delete"));
    expect(onDeleteVod).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onDeleteVod).toHaveBeenCalledWith("v2");
  });

  test("copy link reports the item", async () => {
    const { onCopyLink } = renderBoard();
    const user = userEvent.setup();
    await user.click(within(vodRow("v1")).getByTestId("vod-copy-link"));
    expect(onCopyLink).toHaveBeenCalledWith("vod", "v1");
  });

  test("the clips tab lists clip cards and deletes after confirming", async () => {
    const { onDeleteClip } = renderBoard();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("content-tab-clips"));
    const panel = await screen.findByTestId("content-clips");
    const row = within(panel).getByTestId("clip-row");
    expect(attr(row, "data-clip-id")).toBe("c1");
    expect(row.textContent).toContain("Clipped by Fernsby");
    expect(row.textContent).toContain("1.2K views");
    await user.click(within(row).getByTestId("clip-delete"));
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onDeleteClip).toHaveBeenCalledWith("c1");
  });

  test("both panels stay mounted, so clip cards are queryable before the clips tab is opened", () => {
    renderBoard();
    const clipsPanel = screen.getByTestId("content-clips");
    expect(clipsPanel.hidden).toBe(true);
    expect(attr(within(clipsPanel).getByTestId("clip-row"), "data-clip-id")).toBe("c1");
    expect(screen.getByTestId("content-vods").hidden).toBe(false);
  });

  test("sorting by most watched reorders the cards", async () => {
    const more = [
      { ...vods[0]!, id: "low", views: 1, createdAt: "2026-11-05T00:00:00Z" },
      { ...vods[0]!, id: "high", views: 900, createdAt: "2026-11-01T00:00:00Z" },
    ];
    renderBoard({ vods: more });
    const order = () => screen.getAllByTestId("vod-row").map((r) => attr(r, "data-vod-id"));
    expect(order()).toEqual(["low", "high"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Sort by" }));
    await user.click(await screen.findByTestId("content-sort-option-views"));
    expect(order()).toEqual(["high", "low"]);
  });

  test("one item: no sort bar", () => {
    renderBoard({ vods: [vods[0]!], clips: [] });
    expect(screen.queryByTestId("content-sort")).toBeNull();
  });

  test("the two empty states differ by data-kind", () => {
    renderBoard({ vods: [], clips: [] });
    expect(screen.getAllByTestId("content-empty").map((el) => attr(el, "data-kind"))).toEqual(["vods", "clips"]);
  });

  test("loading renders skeletons, not the empty state", () => {
    renderBoard({ vods: null, clips: null });
    const panel = screen.getByTestId("content-vods");
    expect(within(panel).queryByTestId("content-empty")).toBeNull();
    expect(panel.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  test("the server's copy replaces an open draft", async () => {
    const { rerender } = renderBoard();
    const user = userEvent.setup();
    await user.click(within(vodRow("v1")).getByTestId("vod-edit"));
    const sheet = await screen.findByTestId("vod-edit-sheet");
    await user.type(within(sheet).getByTestId("vod-title"), " draft");
    act(() => {
      rerender(
        withTooltips(
          <ContentBoard
            vods={[{ ...vods[0]!, title: "From server" }]}
            clips={clips}
            labels={contentLabels}
            onSaveVod={() => undefined}
            onDeleteVod={() => undefined}
            onDeleteClip={() => undefined}
          />,
        ),
      );
    });
    expect((within(screen.getByTestId("vod-edit-sheet")).getByTestId("vod-title") as HTMLInputElement).value).toBe(
      "From server",
    );
  });
});

describe("OverlayTokenPanel links", () => {
  const status = { active: true, createdAt: "2026-10-20T12:00:00Z", expiresAt: null };
  const renderPanel = (props: Partial<React.ComponentProps<typeof OverlayTokenPanel>> = {}) =>
    render(
      withTooltips(
        <OverlayTokenPanel
          status={status}
          labels={overlayTokenLabels}
          onCreate={() => undefined}
          onRevoke={() => undefined}
          {...props}
        />,
      ),
    );

  test("all three links, each with its browser-source size", () => {
    renderPanel({ createdUrls: overlayUrls });
    for (const kind of OVERLAY_KINDS) {
      const el = screen.getByTestId(overlayUrlTestId(kind));
      expect([attr(el, "data-url"), attr(el, "data-width"), attr(el, "data-height")]).toEqual([
        overlayUrls[kind],
        String(OVERLAY_SIZES[kind].width),
        String(OVERLAY_SIZES[kind].height),
      ]);
      expect(within(el).getByTestId(`${overlayUrlTestId(kind)}-value`)).toBeTruthy();
    }
    expect(screen.getByTestId("overlay-url").textContent).toContain("800 × 600 px");
    expect(screen.getByTestId("overlay-url-chat").textContent).toContain("400 × 800 px");
    expect(screen.getByTestId("overlay-url-goals").textContent).toContain("800 × 120 px");
    expect(screen.queryByTestId("overlay-sizes")).toBeNull();
  });

  test("without links on screen: the sizes, and (active) why the links are not shown", () => {
    renderPanel();
    const sizes = screen.getByTestId("overlay-sizes");
    expect([...sizes.querySelectorAll("li")].map((li) => attr(li, "data-kind"))).toEqual([...OVERLAY_KINDS]);
    expect(sizes.textContent).toContain("400 × 800 px");
    expect(screen.getByText(overlayTokenLabels.linksHidden as string)).toBeTruthy();
  });

  test("no token yet: the sizes without the hidden-links note", () => {
    renderPanel({ status: { active: false, createdAt: null, expiresAt: null } });
    expect(screen.getByTestId("overlay-sizes")).toBeTruthy();
    expect(screen.queryByText(overlayTokenLabels.linksHidden as string)).toBeNull();
  });

  test("the OBS steps open from their toggle", async () => {
    renderPanel();
    const help = screen.getByTestId("overlay-obs-help");
    await userEvent.setup().click(within(help).getByRole("button", { name: overlayTokenLabels.obsTitle }));
    expect(help.textContent).toContain("choose Browser");
    expect(help.querySelectorAll("li")).toHaveLength(4);
  });
});
