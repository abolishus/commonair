// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `/following` (wave 2, D3.5): signed out, the way to sign in back to this page; nobody followed,
 * an empty state pointing to Browse; otherwise Live now, then offline rows with a go-live alert
 * bell that saves through `channels.follow`, rolls back when it fails, and pages with Show more.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MEMBER, home, live, offline } from "./d1-fixtures.tsx";
import { renderHome } from "./d3-home-fixtures.tsx";

type Row = { channel: ReturnType<typeof live>["channel"]; live: unknown; followedAt: string; notify: boolean };
const fake = vi.hoisted(() => ({
  follows: null as unknown as (input: { cursor?: string }) => Promise<{ items: Row[]; nextCursor: string | null }>,
  follow: vi.fn<(input: unknown) => Promise<unknown>>(),
  tracked: [] as string[],
  toasts: [] as string[],
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    me: { follows: (input: { cursor?: string }) => fake.follows(input) },
    channels: { follow: (input: unknown) => fake.follow(input) },
    directory: { home: () => new Promise(() => {}) },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => fake.tracked.push(`${surface}|${action}|${step}`),
}));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => fake.toasts.push(`ok:${m}`),
    error: (m: string) => fake.toasts.push(`err:${m}`),
  },
}));

const { FollowingPage } = await import("../src/components/following/following-page.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { t } = await import("../src/i18n/index.ts");

const row = (slug: string, over: Partial<Row> = {}): Row => ({
  channel: live(slug).channel,
  live: null,
  followedAt: "2026-11-01T12:00:00.000Z",
  notify: true,
  ...over,
});

beforeEach(() => {
  fake.follow = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ following: true, followerCount: 1 }));
  fake.tracked = [];
  fake.toasts = [];
});
afterEach(() => {
  cleanup();
  resetHomeFeed();
});

describe("signed out", () => {
  it("offers sign-in back to /following and a free account, and counts the view", async () => {
    await renderHome(<FollowingPage me={null} />, "/following");
    const box = screen.getByTestId("following-signed-out");
    expect(box.textContent).toContain(t("d3Home.followingPage.signedOut.title"));
    // The sign-up prompt's buttons: create leads, both carry intent follow and come back here.
    const params = (id: string) => {
      const url = new URL(screen.getByTestId(id).getAttribute("href") ?? "", "https://x.invalid");
      return [url.pathname, Object.fromEntries(url.searchParams)];
    };
    expect(params("following-signup")).toEqual(["/signup", { intent: "follow", redirect: "/following" }]);
    expect(params("following-signin")).toEqual(["/signin", { intent: "follow", redirect: "/following" }]);
    expect(fake.tracked).toContain("following|view|follow");
    fireEvent.click(screen.getByTestId("following-signup"));
    expect(fake.tracked).toContain("authGate|create|follow");
  });
});

describe("signed in", () => {
  it("shows a steady loading list, then the empty state pointing to Browse", async () => {
    let answer: (v: { items: Row[]; nextCursor: null }) => void = () => {};
    fake.follows = () => new Promise((resolve) => (answer = resolve));
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    expect(screen.getByTestId("following-loading")).toBeTruthy();
    await act(async () => answer({ items: [], nextCursor: null }));
    const empty = await screen.findByTestId("following-empty");
    expect(empty.textContent).toContain(t("d3Home.followingPage.empty.title"));
    expect(within(empty).getByText(t("d3Home.followingPage.empty.action")).closest("a")?.getAttribute("href")).toBe(
      "/directory",
    );
  });

  it("lists Live now first, then offline rows most recently live first", async () => {
    primeHomeFeed(
      home({
        following: [live("busy", { viewers: 40 })],
        followingOffline: [offline("old", "2026-10-01T00:00:00.000Z"), offline("new", "2026-11-03T00:00:00.000Z")],
      }),
      MEMBER.id,
    );
    fake.follows = async () => ({
      items: [
        row("old"),
        row("busy", { live: live("busy", { viewers: 40 }).broadcast }),
        row("new", { notify: false }),
      ],
      nextCursor: null,
    });
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    const liveSection = await screen.findByTestId("following-live");
    expect(
      [...liveSection.querySelectorAll('[data-testid="stream-card"]')].map((e) => e.getAttribute("data-channel")),
    ).toEqual(["busy"]);
    const rows = screen.getAllByTestId("following-row");
    expect(rows.map((r) => r.getAttribute("data-channel"))).toEqual(["new", "old"]);
    expect(rows.map((r) => r.getAttribute("data-notify"))).toEqual(["false", "true"]);
    expect(rows[1]?.querySelector('a[href="/old"]')).not.toBeNull();
    expect(screen.queryByTestId("following-more")).toBeNull();
  });

  it("the bell turns alerts on and off through channels.follow, and rolls back when it fails", async () => {
    fake.follows = async () => ({ items: [row("fern", { notify: false })], nextCursor: null });
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    const bell = await screen.findByTestId("following-bell");
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    expect(bell.getAttribute("aria-label")).toBe(t("d3Home.followingPage.alertOff", { channel: "fern" }));
    await act(async () => fireEvent.click(bell));
    expect(fake.follow).toHaveBeenCalledWith({ channel: "fern", notify: true });
    await waitFor(() => expect(screen.getByTestId("following-row").getAttribute("data-notify")).toBe("true"));
    expect(fake.toasts).toContain(`ok:${t("d3Home.followingPage.alertOnToast", { channel: "fern" })}`);

    fake.follow = vi.fn<(input: unknown) => Promise<unknown>>(async () => {
      throw new Error("down");
    });
    await act(async () => fireEvent.click(screen.getByTestId("following-bell")));
    expect(fake.follow).toHaveBeenCalledWith({ channel: "fern", notify: false });
    await waitFor(() => expect(screen.getByTestId("following-row").getAttribute("data-notify")).toBe("true"));
    expect(fake.toasts).toContain(`err:${t("d3Home.followingPage.alertFailed", { channel: "fern" })}`);
  });

  it("Show more appends the next page without repeating a channel", async () => {
    fake.follows = async (input) =>
      input.cursor
        ? { items: [row("b"), row("c")], nextCursor: null }
        : { items: [row("a"), row("b")], nextCursor: "next" };
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    await screen.findAllByTestId("following-row");
    await act(async () => fireEvent.click(screen.getByTestId("following-more")));
    await waitFor(() =>
      expect(screen.getAllByTestId("following-row").map((r) => r.getAttribute("data-channel"))).toEqual([
        "a",
        "b",
        "c",
      ]),
    );
    expect(screen.queryByTestId("following-more")).toBeNull();
  });

  it("a failed load says which section and offers Retry", async () => {
    let calls = 0;
    fake.follows = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("bad"), { code: "BAD_REQUEST", status: 400 });
      return { items: [row("a")], nextCursor: null };
    };
    await renderHome(<FollowingPage me={MEMBER} />, "/following");
    const error = await screen.findByTestId("following-load-error");
    expect(error.textContent).toContain(t("d3Home.followingPage.list"));
    await act(async () => fireEvent.click(within(error).getByRole("button")));
    expect(await screen.findByTestId("following-row")).toBeTruthy();
  });
});
