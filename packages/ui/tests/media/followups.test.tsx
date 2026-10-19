// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** U7 follow-ups: CommentItem/CommentList, the StreamCard uptime overlay and icon sizing on the badges. */
import type * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ViewIcon } from "@hugeicons/core-free-icons";
import { describe, expect, test, vi } from "vite-plus/test";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { CommentItem, CommentList, StreamGrid } from "../../src/blocks/media/index.ts";
import { OverlayBadge } from "../../src/primitives/overlay-badge.tsx";
import { StreamCard } from "../../src/primitives/stream-card.tsx";
import { ViewerCount } from "../../src/primitives/viewer-count.tsx";

const stream: StreamCardData = {
  channel: { id: "c1", slug: "rivertide", displayName: "rivertide", avatarUrl: null, accent: "teal" },
  broadcast: {
    id: "b1",
    title: "Rebuilding a tape deck",
    category: { id: "g1", slug: "science", name: "Science" },
    startedAt: "2026-10-19T10:00:00Z",
    mature: false,
    viewerCount: 2400,
    thumbnailUrl: null,
  },
  tags: [],
  language: "en",
  reason: "following",
};

describe("CommentList and CommentItem", () => {
  test("a named list of comments with author, member class, time, body and actions", () => {
    const reply = vi.fn<() => void>();
    render(
      <CommentList label="Comments">
        <CommentItem
          author="Wren & Ash"
          accent="amber"
          badge="Streamer member"
          time="2 h ago"
          data-testid="comment"
          actions={[
            { id: "helpful", label: "Helpful · 38", pressed: true },
            { id: "reply", label: "Reply", onAction: reply },
          ]}
        >
          <p>Second region first.</p>
        </CommentItem>
        <CommentItem author="kanjikat" time="1 h ago">
          <p>Agreed.</p>
        </CommentItem>
      </CommentList>,
    );
    const list = screen.getByRole("list", { name: "Comments" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const first = screen.getByTestId("comment");
    expect(within(first).getByText("Wren & Ash")).toBeTruthy();
    expect(within(first).getByText("Streamer member")).toBeTruthy();
    expect(within(first).getByText("2 h ago")).toBeTruthy();
    expect(within(first).getByText("Second region first.")).toBeTruthy();
    expect(within(first).getByRole("button", { name: "Helpful · 38" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(first).getByRole("button", { name: "Reply" }));
    expect(reply).toHaveBeenCalledOnce();
    expect(within(items[1] as HTMLElement).queryByRole("button")).toBeNull();
  });
});

describe("StreamCard uptime overlay", () => {
  test("uptimeLabel shows over the thumbnail's bottom-end corner", () => {
    const { container } = render(<StreamCard stream={stream} href="#rivertide" uptimeLabel="3:41:09" />);
    const badge = container.querySelector("[data-slot=stream-card-uptime]");
    expect(badge?.textContent).toBe("3:41:09");
    expect(badge?.className).toContain("end-2");
    expect(badge?.className).toContain("bottom-2");
    expect(screen.getByRole("link").textContent).toContain("3:41:09");
  });

  test("no uptimeLabel, no overlay", () => {
    const { container } = render(<StreamCard stream={stream} href="#rivertide" />);
    expect(container.querySelector("[data-slot=stream-card-uptime]")).toBeNull();
  });

  test("StreamGrid passes uptimeLabel through cardProps", () => {
    const { container } = render(
      <StreamGrid streams={[stream]} hrefFor={() => "#x"} cardProps={() => ({ uptimeLabel: "0:48:30" })} />,
    );
    expect(container.querySelector("[data-slot=stream-card-uptime]")?.textContent).toBe("0:48:30");
  });
});

describe("badge icons are sized on the element", () => {
  test("ViewerCount sizes its icon per size variant, without child selectors", () => {
    const { container, rerender } = render(<ViewerCount count={12} size="sm" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/\[&/);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-3");
    rerender(<ViewerCount count={12} size="md" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-3.5");
  });

  test("OverlayBadge sm relies on Badge's own svg size", () => {
    const { container } = render(
      <OverlayBadge size="sm" icon={ViewIcon}>
        12
      </OverlayBadge>,
    );
    // Exactly one svg size rule: Badge's own, none added by OverlayBadge.
    expect((container.firstElementChild as HTMLElement).className.match(/\[&>svg\]:size-3!/g)).toHaveLength(1);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

const cases: [string, React.ReactElement][] = [
  [
    "CommentList",
    <CommentList key="c" label="Comments">
      <CommentItem author="a" time="now" badge="Member" actions={[{ id: "r", label: "Reply" }]}>
        <p>Hi</p>
      </CommentItem>
    </CommentList>,
  ],
  ["StreamCard (uptime)", <StreamCard key="s" stream={stream} href="#x" uptimeLabel="1:00:00" />],
];

describe("media follow-ups SSR and hydration", () => {
  test.each(cases)("%s hydrates without warnings", async (_name, node) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(node);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, node, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
